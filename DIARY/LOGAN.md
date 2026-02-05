# ---> Thoughts, Intentions, Choices, Incidents, Mitigations, Desires --->

Why not restructure so an actor owns the header?

That's a valid alternative architecture:

### Current (HeaderActor + static HTML) |	Alternative (Actor owns header)
Header HTML in template             |	Actor creates header DOM
HeaderActor is "glue"               |	Actor subscribes + updates directly
Simple, pragmatic	                  | More encapsulated
Template changes need manual sync	  | Self-contained
We chose the current approach because:

Header layout is in the extension's HTML template (legacy)
ModelSelectorShadowActor popup positions relative to the header button
Restructuring = moving lots of HTML into actor-managed DOM
