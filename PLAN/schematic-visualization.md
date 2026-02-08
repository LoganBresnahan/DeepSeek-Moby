# Schematic Visualization

## Goal

Develop a middle-ground communication layer between humans and LLMs using "visual" structure—diagrams, interactive shapes, and spatial representations—that transcends pure text while leveraging the cognitive advantages of structured visual reasoning.

---

## The Problem

Text is sequential and linear. Diagrams are spatial and relational. When communicating complex system architecture, data flows, or conceptual relationships, text forces both humans and LLMs to serialize inherently parallel information.

```
Text: "A connects to B, which connects to C and D, while E monitors A"

Diagram:
    ┌───┐
    │ E │ ──monitors──┐
    └───┘             │
                      ▼
    ┌───┐    ┌───┐    ┌───┐
    │ A │───▶│ B │───▶│ C │
    └───┘    └───┘    └───┘
                 │
                 └───▶┌───┐
                      │ D │
                      └───┘
```

The diagram communicates structure instantly. The text requires mental reconstruction.

---

## Academic Foundations

### 1. Dual Process Theory (Cognitive Science)

From [IJCAI-25 research on Neuro-Symbolic AI](https://www.ijcai.org/proceedings/2025/1195.pdf):

| System | Characteristics | Analog |
|--------|-----------------|--------|
| **System 1** | Fast, intuitive, unconscious | Neural networks, pattern matching |
| **System 2** | Slower, deliberate, conscious | Symbolic reasoning, logical rules |

**Insight**: Schematic visualization bridges these systems—visual intuition (System 1) meeting structured reasoning (System 2). Users can "see" a concept quickly while the structure enables precise reasoning.

---

### 2. Qualitative Spatial and Temporal Reasoning (QSTR)

From [Springer's Spatial Cognition research](https://link.springer.com/book/10.1007/3-540-69342-4):

A field that models human-level spatial understanding for AI. Applications:
- Robot navigation
- Geographic information systems (GIS)
- Natural language understanding
- Computer-aided design

**Key concepts**:
- **Egocentric reference frame**: Spatial info encoded relative to the observer's body
- **Allocentric reference frame**: Relations between objects independent of observer
- **Route knowledge** vs **Survey knowledge**: Sequential path understanding vs bird's-eye-view understanding

**Insight**: Interactive 2D shape manipulation could enable users to express spatial relationships directly, bypassing the lossy text serialization.

---

### 3. Embodied Cognition & Tangible/Embodied Interfaces (TEIs)

From [Oxford Academic](https://academic.oup.com/iwc/article/32/4/331/5976293) and [Cognitive Research](https://link.springer.com/article/10.1186/s41235-016-0032-5):

> "Aspects of spatial cognition are embodied and these findings can be used to influence the design of tangible and embodied interfaces."

TEIs bring interaction with digital content off the screen and into physical movement. Research shows:

- Gestural interfaces enhance spatial description, embodied memory, visualization
- Physical movement and tangible feedback improve spatial cognition
- People using tangible interfaces solve puzzles faster and employ more exploratory strategies

**Research finding** ([HCII 2024](https://link.springer.com/chapter/10.1007/978-3-031-61685-3_4)):
> "Students employed sweeping hand motions to vividly illustrate the layers of virtual objects, providing a tangible representation of depth."

**Insight**: The mousepad idea connects here—gesture as a communication channel to the LLM.

---

### 4. Visual Knowledge Graph Integration

From [NeurIPS 2024 - GraphVis](https://neurips.cc/virtual/2024/poster/94055):

> "Most current KG-enhanced LLM methods directly convert the KG into linearized text triples, which is not as expressive as the original structured data."

**GraphVis** preserves graph structure through visual modality for LLM comprehension:
- **11.1% average improvement** over text-only approaches
- Better zero-shot visual QA performance
- Structure preserved visually vs lost in text linearization

**Insight**: LLMs understand structure better visually than as serialized text. Schematic visualization could be the native format for complex system communication.

---

### 5. Semantic Networks & Concept Maps

From [semantic network theory](https://en.wikipedia.org/wiki/Semantic_network) and [CMap research](https://cmap.ihmc.us/docs/theory-of-concept-maps):

**Semantic networks**: Knowledge bases representing semantic relations between concepts as graphs.
- Vertices = concepts
- Edges = semantic relations
- Used in ML, expert systems, knowledge representation

**Concept maps**: Visual representations of semantic networks with:
- Concepts in circles/boxes
- Connecting lines with linking words
- Hierarchical or networked structure

**Spreading activation**: Activating one node leads to connected nodes' activation—mimics human memory retrieval.

**Insight**: Interactive concept maps could be a shared representation between human and AI, with spreading activation visualized in real-time.

---

### 6. Centaur Intelligence

From [ResearchGate](https://www.researchgate.net/publication/393049798):

> "The emergence of Centaur Intelligence—defined as the synergistic collaboration between human and artificial intelligence—marks a transformative moment in the history of knowledge creation."

> "When insight is no longer the product of a single mind, but a collaborative emergence from hybrid systems, new methods are required to interpret, curate, and reflect upon that knowledge."

Researchers created "semantic-emotional cartography" from human-AI coauthored work.

**Insight**: Schematic visualization could be the native medium for centaur cognition—a shared visual workspace where human intuition and AI reasoning meet.

---

### 7. Explorable Explanations (Bret Victor / Dynamicland)

From [worrydream.com](https://worrydream.com/) and [related analysis](https://medium.com/@Max_Goldstein/exploring-explorable-explanations-92f865c8d6ba):

> "People currently think of text as information to be consumed. I want text to be used as an environment to think in."

**Key concepts**:
- **Interactive diagrams** that evolve with user input
- **Ubiquitous visualization**: Everything is on display
- **Direct manipulation**: Lower cognitive load through sliders, contextual lookups
- **Dynamicland**: Room-sized tangible computing where programs exist as physical objects

> "Most modern visualizations are programmed, where a single description can dynamically generate a unique picture for any dataset. Today's tools offer the benefits of one or the other—either directness or dynamics—but not both."

Notable authors: Bret Victor, Nicky Case, Vi Hart, Dan Shiffman

**Insight**: The chat stream could become an explorable environment, not just a text log.

---

### 8. Visual Programming Languages

From [Springer spatial logic research](https://link.springer.com/article/10.1007/BF00127678):

> "Visual computer languages exploit the natural language of diagrams and pictures to provide a simple and intelligible approach to programming."

Research shows:
- Spreadsheet programmers develop data-flow mental representations
- Visual languages allow quicker construction of mental representations
- Imagery processing facilitates faster access to semantic information

**Insight**: There may be a "visual DSL" for human-AI communication waiting to be discovered.

---

## Implementation Ideas

### Phase 1: 2D Shape Canvas in Chat

A modal or inline canvas where users can:
- Drag and position shapes (boxes, circles, arrows)
- Connect shapes with labeled edges
- Group shapes into containers
- Add text labels

The canvas state serializes to a structured format the LLM can parse:

```typescript
interface DiagramState {
  nodes: Array<{
    id: string;
    type: 'box' | 'circle' | 'diamond';
    label: string;
    position: { x: number; y: number };
    group?: string;
  }>;
  edges: Array<{
    from: string;
    to: string;
    label?: string;
    type: 'arrow' | 'line' | 'dashed';
  }>;
  groups: Array<{
    id: string;
    label: string;
    bounds: { x: number; y: number; width: number; height: number };
  }>;
}
```

### Phase 2: LLM Can Generate Diagrams

Teach the LLM to output diagram commands:

```
USER: How does the virtual list actor work?

ASSISTANT: Here's the architecture:

<diagram>
  box VirtualListActor at 200,100 "Manages pool + visibility"
  box MessageTurnActor at 100,200 "One per turn"
  box MessageTurnActor at 200,200 "One per turn"
  box MessageTurnActor at 300,200 "One per turn"
  box Pool at 400,150 "Recycled actors"

  arrow VirtualListActor -> MessageTurnActor "binds"
  arrow Pool -> VirtualListActor "provides"
  dashed MessageTurnActor -> Pool "returns to"
</diagram>

The VirtualListActor maintains a pool of MessageTurnActor instances...
```

### Phase 3: 3D Visualization

Using Three.js or similar:
- Z-axis for time/layers/abstraction levels
- Rotate view to see system from different angles
- Zoom in/out for detail levels
- Animate state transitions

### Phase 4: Webcam Gesture Input (Experimental)

**Concept**: Use webcam to capture hand/finger movements as input to the LLM.

```
┌─────────────────────────────────────────────────────────────┐
│                    GESTURE FEEDBACK LOOP                     │
│                                                              │
│   ┌──────────┐     ┌──────────────┐     ┌────────────────┐  │
│   │  Webcam  │────▶│ Hand/Finger  │────▶│ Shape/Letter   │  │
│   │  Input   │     │  Tracking    │     │ Recognition    │  │
│   └──────────┘     └──────────────┘     └────────────────┘  │
│        │                                        │            │
│        ▼                                        ▼            │
│   ┌──────────┐                          ┌────────────────┐  │
│   │  Mirror  │◀─────── feedback ────────│  LLM Process   │  │
│   │  Display │                          │  Meaning       │  │
│   └──────────┘                          └────────────────┘  │
│                                                              │
│   User sees themselves mirrored while drawing shapes.        │
│   Tracking points on fingers capture the motion.             │
│   LLM interprets the shapes/letters/words drawn in air.      │
└─────────────────────────────────────────────────────────────┘
```

**Technical approach**:
- MediaPipe Hands or similar for finger tracking (21 landmarks per hand)
- Track fingertip positions over time to recognize gestures
- Mirror the video feed so user sees natural movement
- Recognize: letters, shapes, directional gestures, spatial arrangements

**Use cases**:
- Draw a box in the air → create a component node
- Draw an arrow → create a connection
- Pinch gesture → select/group
- Trace letters → spell labels
- Point at screen regions → reference existing elements

**Why this matters**:
- Entire body motion becomes input, not just keyboard/mouse
- Mirrored feedback loop creates embodied cognition
- Natural expression of spatial relationships
- Could work on tablet/touch devices too

---

## Potential Libraries

### 2D Canvas
- **Fabric.js**: Rich 2D canvas with object model
- **Konva.js**: High-performance 2D drawing
- **JointJS/Rappid**: Diagramming library
- **React Flow**: Node-based graph UI

### 3D
- **Three.js**: General 3D rendering
- **React Three Fiber**: React bindings for Three.js
- **Babylon.js**: Alternative 3D engine

### Gesture/Body Tracking
- **MediaPipe Hands**: Google's hand tracking (21 landmarks per hand)
- **TensorFlow.js Handpose**: Browser-based hand detection
- **Handtrack.js**: Simple hand tracking
- **PoseNet/MoveNet**: Full body pose estimation

---

## Open Questions

1. **Serialization format**: How to represent diagrams for LLM consumption? JSON? Custom DSL? ASCII art?

2. **Bidirectional editing**: Can user and LLM both modify the same diagram in real-time?

3. **Gesture vocabulary**: What's the minimal set of gestures that enables expressive communication?

4. **Cognitive load**: Does adding visual modes increase or decrease mental effort?

5. **Accessibility**: How to make visual communication accessible to visually impaired users?

6. **Mobile/touch**: How does this translate to touch interfaces?

---

## Research Sources

- [Cognitive Science Approaches to Diagrammatic Representations](https://link.springer.com/article/10.1023/A:1006641024593)
- [Neuro-Symbolic AI Survey 2025](https://www.sciencedirect.com/science/article/pii/S2667305325000675)
- [Data Visualization in AI-Assisted Decision-Making](https://www.frontiersin.org/journals/communication/articles/10.3389/fcomm.2025.1605655/full)
- [GraphVis: Visual Knowledge Graph Integration (NeurIPS 2024)](https://neurips.cc/virtual/2024/poster/94055)
- [Embodied Interaction and Spatial Skills](https://academic.oup.com/iwc/article/32/4/331/5976293)
- [Design of Embodied Interfaces for Spatial Cognition](https://link.springer.com/article/10.1186/s41235-016-0032-5)
- [Spatial Cognition Through Gestural Interfaces](https://link.springer.com/chapter/10.1007/978-3-031-61685-3_4)
- [Centaur Intelligence: Semantic-Emotional Visualization](https://www.researchgate.net/publication/393049798)
- [Bret Victor's Works](https://worrydream.com/)
- [Theory of Concept Maps](https://cmap.ihmc.us/docs/theory-of-concept-maps)
- [Spatial Cognition (Springer)](https://link.springer.com/book/10.1007/3-540-69342-4)
- [LLM-Knowledge Graph Survey 2025](https://arxiv.org/html/2510.20345v1)

---

## Terminology

| Term | Definition |
|------|------------|
| **Schematic Visualization** | Communication through structured visual representations |
| **Centaur Intelligence** | Human-AI collaborative cognition |
| **QSTR** | Qualitative Spatial and Temporal Reasoning |
| **TEI** | Tangible and Embodied Interfaces |
| **Spreading Activation** | Node activation propagating through connected nodes |
| **Explorable Explanation** | Interactive, dynamic visualization for understanding |
| **Dual Process Theory** | System 1 (intuitive) + System 2 (deliberate) cognition |

---

## Implementation Phases

### Phase 1: ASCII Diagrams (Current)
- [x] LLM generates ASCII art diagrams in responses
- [ ] Syntax highlighting for ASCII diagrams in chat

### Phase 2: Static 2D Canvas
- [ ] Add diagram modal with shape palette
- [ ] Drag/drop shapes, arrows, labels
- [ ] Serialize to JSON for LLM
- [ ] LLM can reference diagram elements

### Phase 3: Bidirectional Diagrams
- [ ] LLM can output diagram commands
- [ ] Real-time collaboration between user and LLM
- [ ] Animate diagram changes

### Phase 4: 3D Exploration
- [ ] Add Three.js canvas option
- [ ] Z-axis for abstraction layers
- [ ] Rotate/zoom/pan controls

### Phase 5: Gesture Input (Experimental)
- [ ] Webcam access with user permission
- [ ] Hand tracking via MediaPipe
- [ ] Mirror display with tracking overlay
- [ ] Basic gesture recognition (shapes, letters)
- [ ] Gesture → diagram element mapping
