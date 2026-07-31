// design-plan — turn an accepted design doc (docs/plans/*.md) or ADR
// (docs/architecture/decisions/*.md) into an effort-ranked, dependency-ordered
// build checklist. Decompose into buildable slices, rank each slice (in
// parallel) against THIS project's effort philosophy, then order them into
// phases. Reusable: Workflow({ scriptPath: '.claude/workflows/design-plan.js',
// args: '<doc-path>' }); defaults to the current frontier plan. This is a
// *planning/triage* workflow — it decides WHERE effort, verification, and
// ultracode belong; it does not do the implementation.

export const meta = {
  name: 'design-plan',
  description: 'Decompose a design doc or ADR into implementation slices and rank each by effort, verification need, applicable skills, and dependencies — then order them into build phases',
  whenToUse: 'Before implementing an accepted design doc or ADR: turn its decisions into an effort-ranked, dependency-ordered build checklist',
  phases: [
    { title: 'Decompose', detail: 'extract concrete implementation slices from the doc' },
    { title: 'Assess', detail: 'rank each slice: effort, hardness, verify/ultracode, skills, deps, status' },
    { title: 'Plan', detail: 'order slices into dependency-respecting build phases' },
  ],
}

const docPath = (typeof args === 'string' ? args : args && args.doc) || 'docs/plans/subagents.md'

const SLICE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['slices'],
  properties: {
    slices: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'title', 'entails', 'source'],
        properties: {
          id: { type: 'string', description: 'short kebab-case id, e.g. digest-role-registry' },
          title: { type: 'string' },
          entails: { type: 'string', description: 'what building it actually involves' },
          source: { type: 'string', description: 'which doc decision / consequence / open-question it comes from' },
        },
      },
    },
  },
}

const ASSESSMENT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['id', 'status', 'effort', 'hardness', 'model', 'needs_verification', 'skills', 'risk', 'depends_on', 'rationale'],
  properties: {
    id: { type: 'string' },
    status: { type: 'string', enum: ['todo', 'partial', 'done'] },
    effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'], description: 'reasoning-effort ladder; ultracode is the top rung and implies multi-agent orchestration' },
    hardness: { type: 'string', enum: ['mechanical', 'moderate', 'hard-reasoning'] },
    model: { type: 'string', enum: ['fable', 'opus'], description: 'which model should implement this slice — tracks hardness, not size' },
    needs_verification: { type: 'boolean', description: 'an adversarial verify pass is warranted' },
    skills: { type: 'array', items: { type: 'string' }, description: 'Moby skills that apply: shipshape, verify, orient' },
    risk: { type: 'string', enum: ['low', 'medium', 'high'] },
    depends_on: { type: 'array', items: { type: 'string' }, description: 'slice ids that must land first' },
    rationale: { type: 'string', description: 'WHY this effort/hardness/verification — tied to reasoning difficulty' },
  },
}

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['ordered_phases', 'critical_path', 'notes'],
  properties: {
    ordered_phases: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['phase', 'slice_ids', 'model', 'why'],
        properties: {
          phase: { type: 'string', description: 'e.g. "0. already landed" or "1. role registry + routing seam"' },
          slice_ids: { type: 'array', items: { type: 'string' } },
          model: { type: 'string', enum: ['fable', 'opus', 'mixed'], description: 'dominant implementation model for this phase, from the slice assessments' },
          why: { type: 'string' },
        },
      },
    },
    critical_path: { type: 'array', items: { type: 'string' }, description: 'slice ids on the critical path, in order' },
    notes: { type: 'string', description: 'what to batch; which slices genuinely warrant ultracode/verify AND which explicitly do not; sequencing risks' },
  },
}

phase('Decompose')
log(`Decomposing ${docPath} into implementation slices`)
const decomposed = await agent(
  `Read ${docPath} (a design doc or Nygard-style ADR in the DeepSeek Moby VS Code extension repo) fully, and skim the code/docs it references (CLAUDE.md's Architecture section, docs/architecture/, and the src/ or media/ files it names). Extract the concrete IMPLEMENTATION slices it implies — the discrete units a developer would actually build, not the prose sections. For each: a short kebab-case id, a title, what building it entails, and which decision / consequence / open-question of the doc it comes from. Aim for 6-14 buildable-sized slices grounded in the doc's decisions and, where an ADR, its Consequences and Revisit triggers where they imply v1 guard rails. Do not invent work the doc does not imply.`,
  { label: 'decompose', phase: 'Decompose', schema: SLICE_SCHEMA }
)
const slices = (decomposed && decomposed.slices) || []
log(`${slices.length} slices found`)

phase('Assess')
// The full slice roster, so each assessor's depends_on references CANONICAL ids
// rather than inventing aliases — each assessor runs in isolation and would
// otherwise never see the sibling ids.
const roster = slices.map(s => `${s.id} — ${s.title}`).join('\n')
// Parallel (barrier): the Plan phase needs ALL assessments at once to order by dependency.
const assessed = (await parallel(slices.map(slice => () =>
  agent(
    `You are ranking ONE implementation slice from Moby's ${docPath} for HOW to build it. Read the doc section it comes from and the relevant code to judge real difficulty — do not guess.

SLICE: ${JSON.stringify(slice)}

ALL sibling slices (id — title). In depends_on you MUST use only these exact ids, verbatim — never invent, paraphrase, or reword an id:
${roster}

Assess it using THIS project's effort philosophy — be calibrated, do NOT mark everything high:
- effort is the ladder low | medium | high | xhigh | max | ultracode, and it tracks REASONING DIFFICULTY, not size. Mechanical wiring / actor scaffolding / settings plumbing / command registration / straightforward tests = low or medium. Streaming/parsing state machines (fence guards, ContentTransformBuffer), event-sourcing and hydration invariants (ADR 0003), abort/interrupt lifecycle races (ADR 0008), prompt-protocol design that a model must follow reliably, or SQLCipher/key-handling edges = high or xhigh. 'max' = the hardest single-context reasoning — one agent, maximum thinking budget, still no orchestration. 'ultracode' is the TOP rung and means multi-agent orchestration: assign it ONLY when the slice decomposes into parallel work AND is verification-worthy AND a single pass would miss things. Reserve the top two rungs; most slices never reach them — over-marking is the exact failure this project warns about.
- hardness: mechanical | moderate | hard-reasoning.
- model: which model should IMPLEMENT this slice. 'fable' ONLY for hard-reasoning slices where a plausible-but-wrong implementation is the failure mode (stream-state machines, event sequencing/fork semantics, teardown races, subtle prompt-contract design); 'opus' for mechanical and moderate slices (wiring, UI actors, settings, boilerplate, straightforward tests) where throughput matters. Track hardness, not size — a big mechanical slice is still 'opus'.
- needs_verification (an adversarial verify pass) = true ONLY when a subtle bug would be costly and a single pass could plausibly ship it wrong (e.g. an off-by-one in event sequencing that only shows on fork/restore, a fence guard that passes synthetic streams but drops real R1 output, an abort path that leaks a request). Silent-failure classes, not visible-crash classes.
- skills: which Moby skills apply — shipshape (pre-commit gate: build + suites green twice, docs, conventions), verify (runtime verification: headless webview harness or real VS Code dev host — any user-visible surface), orient (rarely).
- status: todo | partial | done — check the code under src/ and media/ rather than assuming.
- depends_on: the exact ids FROM THE ROSTER ABOVE of slices that must land first — [] if none. Do not use any id not in the roster.
Return the structured assessment with an honest rationale.`,
    { label: `assess:${slice.id}`, phase: 'Assess', schema: ASSESSMENT_SCHEMA }
  )
))).filter(Boolean)

phase('Plan')
log(`Ordering ${assessed.length} assessed slices into build phases`)
const plan = await agent(
  `Ranked implementation slices for Moby's ${docPath} (assessments JSON):
${JSON.stringify(assessed, null, 2)}

Their titles / what-they-entail:
${JSON.stringify(slices, null, 2)}

Produce a dependency-respecting build plan: group slices into ordered phases (respect depends_on; put any already-'done' slices in a phase 0), identify the critical path, and in 'notes' call out what to batch, which slices genuinely warrant ultracode/adversarial-verify AND which explicitly do NOT, and any sequencing risks — including where /shipshape and /verify belong at phase boundaries. Prefer grouping same-model slices into the same phase where dependencies allow, and set each phase's 'model' from its slices ('mixed' only when unavoidable) — the maintainer batches Fable work and Opus work separately. Keep it tight and actionable — this is the checklist a developer follows to build the doc.`,
  { label: 'synthesize', phase: 'Plan', schema: PLAN_SCHEMA }
)

return { doc: docPath, sliceCount: slices.length, assessed, plan }
