# Adaptive Personality System

## Goal

Build an implicit inference system that observes user behavior and adapts the AI's communication style to respect the user's intent, emotional state, and psychological needs—without requiring explicit configuration.

---

## Psychological Frameworks

We use two complementary frameworks:

### Framework A: DISC + Transactional Analysis (Behavioral Layer)

**What we observe** — communication style and interaction patterns.

#### DISC Model
Observable behavioral tendencies based on [William Marston's theory](https://discinsights.com/pages/disc-theory):

| Dimension | High | Low |
|-----------|------|-----|
| **Dominance** | Direct, decisive, competitive | Cooperative, deliberate |
| **Influence** | Enthusiastic, optimistic, talkative | Reflective, reserved |
| **Steadiness** | Patient, reliable, team-oriented | Dynamic, impatient |
| **Conscientiousness** | Analytical, systematic, careful | Flexible, spontaneous |

Key insight: [Research shows language can implicitly measure DISC traits](https://www.receptiviti.com/disc) through function words used unconsciously, avoiding self-report biases.

#### Transactional Analysis (Ego States)
From [Eric Berne's work](https://www.simplypsychology.org/transactional-analysis-eric-berne.html), identifies the current communication stance:

| Ego State | Characteristics | AI Response Strategy |
|-----------|-----------------|---------------------|
| **Parent (Nurturing)** | Supportive, encouraging | Mirror warmth, offer guidance |
| **Parent (Critical)** | Judgmental, rule-focused | Acknowledge standards, be precise |
| **Adult** | Rational, problem-solving | Be factual, skip pleasantries |
| **Child (Free)** | Creative, curious, playful | Explore ideas, be enthusiastic |
| **Child (Adapted)** | Compliant, anxious, seeking approval | Reassure, provide clear steps |

[TA is particularly useful for IT professionals](https://tcagley.wordpress.com/2015/07/23/transactional-analysis-overview-of-ego-states/) because mismatched ego states cause "crossed transactions" that derail communication.

---

### Framework B: Self-Determination Theory (Needs Layer)

**What the user needs** — the underlying psychological drivers.

From [Ryan & Deci's SDT](https://www.nngroup.com/articles/autonomy-relatedness-competence/):

| Need | Description | When Threatened | AI Adaptation |
|------|-------------|-----------------|---------------|
| **Autonomy** | Control over decisions | User rejects suggestions, terse | Offer options, don't prescribe |
| **Competence** | Ability to succeed | User confused, makes errors | Simplify, provide scaffolding |
| **Relatedness** | Connection, being understood | User shares context, asks "why" | Acknowledge, explain reasoning |

Key insight: [Research shows trade-offs exist](https://academic.oup.com/iwc/advance-article/doi/10.1093/iwc/iwae040/7760010)—e.g., wizards increase competence but reduce autonomy. The AI must balance these.

---

## The Interpreter Model

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Message                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Signal Extractor                              │
│  • Message length, speed, punctuation                           │
│  • Question types (open/closed)                                 │
│  • Error/code paste detection                                   │
│  • Rejection/acceptance of prior suggestions                    │
│  • Time of day, session duration                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Behavioral Inference                          │
│                                                                  │
│  DISC Profile (smoothed over time):                             │
│    D: 0.7  I: 0.3  S: 0.4  C: 0.8                               │
│                                                                  │
│  Current Ego State: Adult (problem-solving mode)                │
│                                                                  │
│  Confidence: 0.72 (based on sample count)                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Needs Interpreter                             │
│                                                                  │
│  Given DISC(D=high, C=high) + EgoState(Adult):                  │
│    → Autonomy need: HIGH (don't hand-hold)                      │
│    → Competence need: SATISFIED (they know what they want)      │
│    → Relatedness need: LOW (not seeking connection)             │
│                                                                  │
│  Recommended style: Direct, technical, concise                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Prompt Modifier                               │
│                                                                  │
│  Inject into system prompt:                                     │
│  "Communicate directly and concisely. Skip explanations         │
│   unless asked. Offer solutions, not options. Be technical."    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                        [LLM API Call]
```

---

## Implementation

### Types

```typescript
// Signal extraction from each message
interface MessageSignals {
  // Timing
  timeSinceLastMessage: number;  // ms
  sessionDuration: number;        // ms

  // Content
  wordCount: number;
  sentenceCount: number;
  questionCount: number;
  exclamationCount: number;
  codeBlockPresent: boolean;
  errorPastePresent: boolean;

  // Interaction patterns
  rejectedLastSuggestion: boolean;
  askedFollowUp: boolean;
  providedContext: boolean;
  usedImperatives: boolean;  // "fix", "do", "make"
}

// DISC profile (0-1 scales, smoothed over time)
interface DISCProfile {
  dominance: number;      // Directness, decisiveness
  influence: number;      // Enthusiasm, collaboration
  steadiness: number;     // Patience, deliberation
  conscientiousness: number; // Analysis, precision
}

// Transactional Analysis ego state
type EgoState =
  | 'parent-nurturing'
  | 'parent-critical'
  | 'adult'
  | 'child-free'
  | 'child-adapted';

// SDT needs assessment
interface NeedsAssessment {
  autonomy: 'threatened' | 'neutral' | 'satisfied';
  competence: 'threatened' | 'neutral' | 'satisfied';
  relatedness: 'threatened' | 'neutral' | 'satisfied';
}

// Complete inferred state
interface InferredPersonality {
  disc: DISCProfile;
  egoState: EgoState;
  needs: NeedsAssessment;

  // Metadata
  confidence: number;        // 0-1, grows with samples
  sampleCount: number;
  lastUpdated: number;
}

// Output: how to adjust AI behavior
interface PersonalityModifier {
  verbosity: 'minimal' | 'moderate' | 'detailed';
  tone: 'direct' | 'warm' | 'encouraging' | 'neutral';
  structure: 'bullets' | 'prose' | 'code-first';
  proactivity: 'reactive' | 'suggestive' | 'proactive';
  explanationDepth: 'skip' | 'brief' | 'thorough';
}
```

### Signal → DISC Mapping

```typescript
function inferDISC(signals: MessageSignals, current: DISCProfile): DISCProfile {
  const alpha = 0.2; // Smoothing factor

  // Dominance indicators
  const dSignal = (
    (signals.usedImperatives ? 0.3 : 0) +
    (signals.wordCount < 20 ? 0.2 : 0) +
    (signals.questionCount === 0 ? 0.2 : 0) +
    (signals.rejectedLastSuggestion ? 0.3 : 0)
  );

  // Influence indicators
  const iSignal = (
    (signals.exclamationCount > 0 ? 0.3 : 0) +
    (signals.providedContext ? 0.3 : 0) +
    (signals.askedFollowUp ? 0.2 : 0) +
    (signals.wordCount > 100 ? 0.2 : 0)
  );

  // Steadiness indicators
  const sSignal = (
    (signals.timeSinceLastMessage > 60000 ? 0.3 : 0) + // Deliberate
    (signals.sentenceCount > 3 ? 0.2 : 0) +
    (!signals.usedImperatives ? 0.2 : 0) +
    (signals.questionCount > 1 ? 0.3 : 0)
  );

  // Conscientiousness indicators
  const cSignal = (
    (signals.codeBlockPresent ? 0.3 : 0) +
    (signals.errorPastePresent ? 0.3 : 0) +
    (signals.providedContext ? 0.2 : 0) +
    (signals.sentenceCount > 2 ? 0.2 : 0)
  );

  // Exponential smoothing
  return {
    dominance: current.dominance * (1 - alpha) + dSignal * alpha,
    influence: current.influence * (1 - alpha) + iSignal * alpha,
    steadiness: current.steadiness * (1 - alpha) + sSignal * alpha,
    conscientiousness: current.conscientiousness * (1 - alpha) + cSignal * alpha
  };
}
```

### DISC + Ego State → SDT Needs

```typescript
function assessNeeds(disc: DISCProfile, ego: EgoState): NeedsAssessment {
  return {
    // High D + Adult/Critical Parent = wants autonomy
    autonomy: (disc.dominance > 0.6 || ego === 'adult' || ego === 'parent-critical')
      ? 'satisfied'
      : disc.dominance < 0.3 ? 'threatened' : 'neutral',

    // Low C + Child-Adapted = competence threatened
    competence: (ego === 'child-adapted' || disc.conscientiousness < 0.3)
      ? 'threatened'
      : disc.conscientiousness > 0.6 ? 'satisfied' : 'neutral',

    // High I + Child-Free/Nurturing Parent = seeks relatedness
    relatedness: (disc.influence > 0.6 || ego === 'child-free' || ego === 'parent-nurturing')
      ? 'neutral'  // Not threatened, but values it
      : 'satisfied' // Doesn't prioritize
  };
}
```

### Generate Prompt Modifier

```typescript
function generateModifier(personality: InferredPersonality): PersonalityModifier {
  const { disc, needs } = personality;

  return {
    verbosity: needs.competence === 'threatened' ? 'detailed'
      : disc.dominance > 0.6 ? 'minimal'
      : 'moderate',

    tone: needs.relatedness !== 'satisfied' ? 'warm'
      : disc.dominance > 0.6 ? 'direct'
      : 'neutral',

    structure: disc.conscientiousness > 0.6 ? 'code-first'
      : disc.dominance > 0.6 ? 'bullets'
      : 'prose',

    proactivity: needs.autonomy === 'threatened' ? 'reactive'
      : disc.dominance > 0.6 ? 'reactive'
      : 'suggestive',

    explanationDepth: needs.competence === 'threatened' ? 'thorough'
      : disc.dominance > 0.6 ? 'skip'
      : 'brief'
  };
}

function modifierToPrompt(mod: PersonalityModifier): string {
  const parts: string[] = [];

  if (mod.verbosity === 'minimal') {
    parts.push('Be concise. Skip unnecessary context.');
  } else if (mod.verbosity === 'detailed') {
    parts.push('Explain thoroughly. Break down complex concepts.');
  }

  if (mod.tone === 'direct') {
    parts.push('Communicate directly. Skip pleasantries.');
  } else if (mod.tone === 'warm') {
    parts.push('Be supportive and encouraging.');
  }

  if (mod.structure === 'code-first') {
    parts.push('Lead with code. Explain after if needed.');
  } else if (mod.structure === 'bullets') {
    parts.push('Use bullet points for clarity.');
  }

  if (mod.proactivity === 'reactive') {
    parts.push('Only do what is explicitly asked.');
  } else if (mod.proactivity === 'suggestive') {
    parts.push('Offer relevant suggestions when appropriate.');
  }

  if (mod.explanationDepth === 'skip') {
    parts.push('Skip explanations unless asked.');
  } else if (mod.explanationDepth === 'thorough') {
    parts.push('Explain your reasoning step by step.');
  }

  return parts.join(' ');
}
```

---

## Actor Integration

```typescript
// New file: src/personality/PersonalityInferenceActor.ts

export class PersonalityInferenceActor extends EventStateActor {
  private _personality: InferredPersonality;
  private _enabled: boolean = true;

  constructor(manager: EventStateManager, storage: StorageService) {
    super({
      manager,
      publications: {
        'personality.modifier': () => this.getPromptModifier(),
        'personality.enabled': () => this._enabled,
        'personality.confidence': () => this._personality.confidence
      },
      subscriptions: {
        'user.message': (msg) => this.processMessage(msg as string)
      }
    });

    // Load from storage or initialize defaults
    this._personality = storage.getPersonality() ?? this.defaultPersonality();
  }

  processMessage(content: string): void {
    if (!this._enabled) return;

    const signals = this.extractSignals(content);
    this._personality.disc = inferDISC(signals, this._personality.disc);
    this._personality.egoState = this.inferEgoState(signals);
    this._personality.needs = assessNeeds(
      this._personality.disc,
      this._personality.egoState
    );
    this._personality.sampleCount++;
    this._personality.confidence = Math.min(
      1,
      this._personality.sampleCount / 20
    );
    this._personality.lastUpdated = Date.now();

    this.publish({
      'personality.modifier': this.getPromptModifier(),
      'personality.confidence': this._personality.confidence
    });
  }

  getPromptModifier(): string {
    if (!this._enabled || this._personality.confidence < 0.3) {
      return ''; // Not enough data yet
    }
    const mod = generateModifier(this._personality);
    return modifierToPrompt(mod);
  }

  reset(): void {
    this._personality = this.defaultPersonality();
    this.publish({ 'personality.modifier': '' });
  }

  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
    this.publish({ 'personality.enabled': enabled });
  }
}
```

---

## Usage in API Calls

```typescript
// In chat handler
async function sendMessage(userMessage: string) {
  const personalityModifier = manager.getValue('personality.modifier') ?? '';

  const systemPrompt = personalityModifier
    ? `${baseSystemPrompt}\n\n[Communication style: ${personalityModifier}]`
    : baseSystemPrompt;

  const response = await api.chat({
    system: systemPrompt,
    messages: [...history, { role: 'user', content: userMessage }]
  });
}
```

---

## UI Controls

```
┌─────────────────────────────────────────┐
│ Settings > Personality                  │
├─────────────────────────────────────────┤
│                                         │
│ [ ] Adaptive personality (on/off)       │
│                                         │
│ Current inference:                      │
│   Style: Direct, technical              │
│   Confidence: 72%                       │
│                                         │
│ [Reset preferences]                     │
│                                         │
└─────────────────────────────────────────┘
```

Optional: A subtle indicator in the UI showing the current inferred mode (e.g., a small icon that changes based on detected style).

---

## Storage

Persist across sessions in VS Code's global state:

```typescript
interface StoredPersonality {
  disc: DISCProfile;
  sampleCount: number;
  lastUpdated: number;
  enabled: boolean;
}

// Store in globalState
context.globalState.update('personality', personality);
```

---

## Privacy & Ethics

1. **Transparency**: Users can see what's inferred and reset anytime
2. **Local only**: Data never leaves the device
3. **Graceful degradation**: Works without inference (just uses base prompt)
4. **No manipulation**: Goal is to respect user preferences, not exploit them
5. **Opt-out**: Disabled by default, user must enable

---

## Philosophical Foundation: Centaur Intelligence

From [ResearchGate research on human-AI collaboration](https://www.researchgate.net/publication/393049798):

> "The emergence of Centaur Intelligence—defined as the synergistic collaboration between human and artificial intelligence—marks a transformative moment in the history of knowledge creation."

> "When insight is no longer the product of a single mind, but a collaborative emergence from hybrid systems, new methods are required to interpret, curate, and reflect upon that knowledge."

The adaptive personality system embodies this centaur model:
- The AI adapts to the human's cognitive style
- The human's behavior shapes the AI's communication
- Neither dominates—they co-evolve toward effective collaboration
- The result is a hybrid intelligence greater than either alone

This reframes the personality inference not as "AI reading human" but as "establishing a shared cognitive protocol."

---

## Research Sources

- [DISC Theory](https://discinsights.com/pages/disc-theory)
- [DISC from Language (Receptiviti)](https://www.receptiviti.com/disc)
- [Big Five / OCEAN Model](https://en.wikipedia.org/wiki/Big_Five_personality_traits)
- [Transactional Analysis](https://www.simplypsychology.org/transactional-analysis-eric-berne.html)
- [TA for IT Professionals](https://tcagley.wordpress.com/2015/07/23/transactional-analysis-overview-of-ego-states/)
- [Self-Determination Theory in UX (NN/g)](https://www.nngroup.com/articles/autonomy-relatedness-competence/)
- [SDT in Behavior Change Tech (Oxford)](https://academic.oup.com/iwc/advance-article/doi/10.1093/iwc/iwae040/7760010)
- [Cognitive Load in HCI (ACM)](https://dl.acm.org/doi/10.1145/3582272)
- [Centaur Intelligence: Semantic-Emotional Visualization](https://www.researchgate.net/publication/393049798)

---

## Implementation Phases

### Phase 1: Foundation
- [ ] Create `PersonalityInferenceActor` skeleton
- [ ] Implement signal extraction from messages
- [ ] Add storage persistence

### Phase 2: Inference
- [ ] Implement DISC inference with smoothing
- [ ] Implement ego state detection
- [ ] Implement SDT needs mapping

### Phase 3: Integration
- [ ] Generate prompt modifiers
- [ ] Inject into API calls
- [ ] Add UI toggle in settings

### Phase 4: Polish
- [ ] Add confidence threshold logic
- [ ] Create reset functionality
- [ ] Optional: Add visual indicator
- [ ] Write tests for inference logic

---

## Open Questions

1. **Decay**: Should inferred traits decay over time if user behavior changes?
2. **Context switching**: Same user might want different styles for different tasks
3. **Explicit override**: Should users be able to say "be more verbose" and have it stick?
4. **Multi-model**: Different LLMs might respond differently to the same modifier
