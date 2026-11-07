# LOOP — QUIRKLAND VISUAL AND ANIMATION IMPLEMENTATION BRIEF

## SHARED INSTRUCTIONS — APPLY TO ALL FOUR STAGES

Upgrade Quirkland into a polished first-person 3D game environment with cinematic lighting, detailed materials, expressive character animation, and convincing physical reactions.

This is an implementation task in the existing game. Inspect the actual code before making changes. Preserve the established architecture, scene lifecycle, player controller, dialogue system, companion behaviour, and scene transitions.

### File ownership and scope

Read CLAUDE.md first and obey its file ownership rules.

- Rework src/scenes/quirkland.js and other files explicitly assigned to me.
- The only additional documentation exception is updating sections 7–9 of docs/GAME.md.
- Do not edit Joshua's files.
- Do not implement or change ending.js.
- Do not rewrite the opening, upside-down London, gravity-flipping mechanic, or holographic globe sequence.
- If a necessary change belongs to someone else, describe the precise integration requirement rather than editing their file.
- Do not install a new engine or replace the existing rendering stack without a demonstrated need.

My newer instructions replace the old four-biome Quirkland layout. Quirkland is now one continuous childlike landscape. Elemental identities belong to characters, not separate geographical zones.

The older globe sequence may still show elemental imagery. Preserve its implementation because that scene is outside this task. Do not recreate four zones inside Quirkland to match it.

### What "realistic" means here

The art direction is polished, surreal, and cartoon-like. Realism comes from:

- Believable illumination and grounded shadows.
- Consistent scale and spatial depth.
- Materials with distinct roughness, reflectivity, and surface detail.
- Characters that anticipate actions, transfer weight, and settle afterward.
- Effects that originate from the correct anatomical or environmental location.
- Secondary motion that follows movement with a slight delay.
- Camera movement that feels intentional and preserves player comfort.
- Sound synchronized to the visible action.

Do not try to make the characters anatomically photorealistic. Do not use a collection of basic primitives and present it as finished character art.

Prefer existing suitable models, custom smooth meshes, or thoughtfully constructed procedural geometry. Use sufficient segments for smooth silhouettes, especially near the camera, but do not add subdivisions where they make no visible improvement.

### Controls and interaction

Preserve:

- WASD movement.
- Mouse look.
- SPACE to jump.
- A small white centre crosshair.
- E to interact.

Show exactly "Press E to interact" when a character is within interaction range and the player is looking toward them.

Use distance, viewing direction, and line of sight. Do not allow interaction through hills or other characters.

Allow only one active character interaction at a time. Repeated E presses must not stack dialogue, duplicate particles, restart the sequence unexpectedly, or trigger multiple transitions.

Use explicit interaction phases:

idle → attention → dialogue → anticipation → demonstration → recovery → companion comment → idle

Characters may have different timings, but they must share dependable interruption and cleanup behaviour.

The Masked Figure has its own terminal interaction sequence.

### Animation requirements

Use frame-rate-independent animation. Drive movement from elapsed time or the existing animation system rather than adding fixed increments each frame.

Give important actions:

1. Anticipation.
2. A clear main motion.
3. Follow-through.
4. A settling phase.

Use appropriate curves:

- Smooth ease-in/ease-out for deliberate gestures.
- Fast release after a slower wind-up for powerful actions.
- Damped springs for tails, ribbons, and soft body settling.
- Restrained asymmetry for organic idle movement.

Do not animate every object with the same sine wave. Vary phase, amplitude, and frequency. Preserve planted feet and contact points wherever possible.

Avoid constant whole-body bobbing as a substitute for acting.

### Camera policy

This is a first-person game. Preserve player ownership of the camera during ordinary exploration.

Do not force the player to watch every demo using a full camera lock. Design demonstrations to remain readable from the interaction area.

Camera control may be temporarily constrained for:

- The existing hydrant introduction.
- The Kite's transport sequence.
- The Masked Figure's final ruby transition.

Restore all prior movement and camera settings after nonterminal sequences, including after cancellation or failure.

Use restrained camera impulses. Provide a reduced-motion setting through existing settings infrastructure, if available. In reduced-motion mode, suppress camera shake and roll and simplify transport movement.

### Technical quality

Use the current project's Three.js version and supported capabilities. Inspect available post-processing and material utilities before introducing alternatives.

- Keep particle counts bounded.
- Reuse particles and temporary objects.
- Share geometries and materials where appropriate.
- Use instancing for repeated candy and ceiling decorations.
- Limit shadow-casting lights.
- Apply distance-based detail where useful.
- Dispose of scene-owned geometry, materials, textures, listeners, audio, and timers when leaving.
- Do not dispose of resources owned by shared systems.
- Avoid expensive full-screen effects for minor details.
- Prevent animation callbacks from modifying the next scene after Quirkland has been destroyed.

Measure performance and report the device/browser or environment used. Do not claim a frame rate or successful visual verification without testing it.

---

# STAGE 1 OF 4 — THE WORLD, ARRIVAL, AND MEMORY SYSTEM

Rework src/scenes/quirkland.js.

Keep the existing fire hydrant intro cutscene and companion behaviour, except for the explicitly requested dialogue change and visual improvements.

## 1. Landscape composition

Create one continuous landscape that looks like a child imagined it and a high-end animated film brought it to life.

Use:

- Bright green grass.
- Soft rolling hills.
- Rounded terrain silhouettes.
- Wobbly, gently winding paths.
- Warm cream, peach, yellow, pink, and lavender accents.
- Candy scattered naturally across the landscape.

The environment must feel cohesive and explorable. Do not divide it into fire, water, air, and nature areas.

Use hills and curves to reveal the world gradually. From the arrival point, show a readable path and a few distant silhouettes rather than every character at once.

Scatter the inhabitants so the player discovers them while exploring. Use visual landmarks and silhouettes rather than oversized floating markers.

Reserve enough clear space around each inhabitant for their demonstration.

## 2. Terrain geometry and surfaces

Create broad, smooth elevation changes with smaller irregularities layered into the terrain.

Avoid:

- Low-poly triangular hills.
- Repeated identical mounds.
- Perfectly flat ground with scattered spheres.
- Abrupt height changes that snag the controller.
- Candy or characters visibly floating above the ground.

Blend grass colour across slopes using subtle variation. Add small patches of clover, rounded flowers, and short grass where they improve foreground detail.

Grass should respond to a shared directional breeze with varied local motion. Keep movement subtle; the ground itself must remain stable.

Paths should have rounded edges, slight surface variation, and believable contact with surrounding grass. Make them look worn or softly pressed into the landscape.

## 3. There is NO sky

Quirkland exists beneath a continuous ceiling.

Do not use a blue sky, stars, an outdoor horizon, or open gaps above the terrain.

The ceiling is covered in many identical large smiling mouths.

The mouths must share the same design:

- Broad curved smiles.
- Rounded lips.
- Simplified smooth teeth.
- Softly shaded mouth interiors.
- No eyes, noses, faces, or additional heads.

They should initially resemble cheerful decorations. Their repetition and scale make them subtly unsettling.

Do not turn them into gore or aggressive horror monsters.

Use a bright childlike ceiling pattern: softly coloured checker shapes, rounded painted motifs, or a similarly coherent playful design. Choose one pattern and execute it consistently.

Make the ceiling visibly present from normal exploration angles. Use lighting and distance haze to communicate its enormous scale without hiding it completely.

Any mouth animation must be extremely restrained. A tiny collective breathing deformation or slow synchronized movement is enough. They must remain recognizably identical.

Do not have every mouth independently chatter, speak, bite, or chase the player.

Resolve the distant boundaries with matching enclosure geometry, hills, and haze so the scene never reveals empty space beyond the ceiling.

## 4. Lighting

Use soft, warm illumination that fits an enclosed imaginary world.

Create directional shaping and gentle contact shadows without implying an outdoor sun or visible sky.

The player should perceive:

- Soft shadows beneath characters and candy.
- Gentle darkening where objects meet the terrain.
- Warm highlights on curved surfaces.
- Slightly cooler shaded areas.
- Clear separation between foreground and distance.

Keep bright colours rich without clipping them into flat neon patches.

Use restrained bloom only for genuinely luminous elements. Ordinary candy and grass should not glow.

## 5. Candy materials and placement

Include lollipops, wrapped sweets, candy canes, and gumdrops.

Give each a distinct surface:

*Lollipops*
- Smooth curved candy surfaces.
- Embedded spiral patterns rather than floating stripes.
- Glossy highlights with slight surface imperfections.
- Rounded sticks planted convincingly into the ground.

*Wrapped sweets*
- Rounded candy volume beneath the wrapper.
- Twisted wrapper ends.
- Small folds that catch light.
- A subtle difference between wrapper and candy materials.

*Candy canes*
- Smooth continuous bends.
- Clean integrated stripes.
- Glossy but slightly roughened candy surfaces.
- Occasional gentle leaning poses.

*Gumdrops*
- Soft rounded forms.
- Semi-translucent or convincingly simulated gummy shading.
- Fine sugar-like surface detail that remains stable in motion.
- A soft contact shadow.

Mix small clusters with isolated pieces. Leave navigable routes. Do not distribute everything in a perfect grid or at uniform density.

Use scale variation deliberately: some candy can be oversized landmarks, but preserve a consistent visual language.

## 6. Ambient animation

Add quiet environmental motion:

- Slight grass movement.
- Gentle flower swaying.
- Minimal wrapper movement on exposed sweet wrappers.
- A few drifting pollen-like particles.
- Subtle secondary movement on flexible candy decorations.

Rigid candy should not wobble like jelly unless intentionally designed that way.

Keep particle density low enough that the world remains clear. Ambient animation supports the characters rather than competing with them.

## 7. Arrival and hydrant introduction

The player arrives standing directly in front of the fire hydrant. The globe transition should appear to end by zooming into him.

Use the existing transition contract. Set the Quirkland spawn position, orientation, and initial camera framing to support that result without editing someone else's transition file.

Frame the hydrant at a comfortable conversation distance. Do not spawn inside his mesh, behind him, or looking away.

Allow a brief visual settling moment before or within the existing introduction timing.

Preserve his established dialogue and ability demonstration, with this exact replacement line:

"The others — the kangaroo, the kite, the infernal one — they're bright and strong. Children still dream about them every night."

Do not invent a replacement backstory or change the chronology.

## 8. Fire hydrant visual performance

The hydrant's remembered value is 0.2.

Keep his recognisable hydrant form, but improve its finish:

- Rounded cap and fittings.
- Painted metal with gentle wear.
- Subtle roughness variation.
- Small surface imperfections.
- Believable contact with the ground.
- Expressive movement using the features already present.

During speech, use small purposeful gestures and pauses. His performance should feel warm and slightly weary.

Use restrained anticipation before movements and soft settling afterward. Do not stretch rigid metal dramatically.

Preserve the companion's following behaviour. Improve visual motion without changing its function:

- Smooth acceleration and deceleration.
- Natural turning.
- A comfortable following distance.
- No constant overlap with the player.
- No walking through other characters.
- No blocking the centre of the screen during demonstrations.

## 9. Remembered system

Give each imaginary inhabitant a remembered value from 0 to 1.

Values:

- Fire hydrant: 0.2
- Intergalactic Kangaroo: 1.0
- Infernal: 0.9
- Kite: 0.85
- Rock Guardian: 0.6
- Water Girl: 0.45
- Tongue Guy: 0.3

The Masked Figure is excluded from this system.

Memory should control a coordinated visual treatment:

- Colour saturation.
- Opacity or stable dithered visibility.
- Contrast.
- Emissive intensity where applicable.
- Subtle visibility of fine surface detail.

Do not simply multiply every colour by remembered; that makes forgotten characters dark rather than faded.

Low-memory characters should look washed out and partially absent while remaining readable and emotionally present.

Use a minimum visible contribution so the hydrant can still be understood during his introduction. The numeric value is an artistic control, not necessarily literal material opacity.

Choose a transparency method that works with the existing renderer. Avoid overlapping transparent body parts becoming visibly darker, incorrect depth ordering, or unstable stippling.

Shadows and ability effects should be visually compatible with fading. A nearly absent character should not cast an inexplicably solid black shadow.

Keep interaction cues legible regardless of memory value.

## 10. Documentation

Update only sections 7–9 of docs/GAME.md to describe:

- The continuous childlike landscape.
- The enclosed ceiling covered in identical smiling mouths.
- The candy.
- The hydrant's introduction and companion role.
- The remembered system.
- Seven inhabitants in addition to the hydrant: Kite, Tongue Guy, Infernal, Water Girl, Intergalactic Kangaroo, Rock Guardian, Masked Figure.
- The Masked Figure's exclusion from memory fading.
- The handoff to the existing ending.

## Stage 1 checks

Confirm:

- The player arrives facing the hydrant.
- His intro and companion behaviour still work.
- The exact replacement dialogue appears.
- No four-biome geography remains.
- There is no visible sky or enclosure gap.
- Candy and terrain are smoothly rendered.
- Movement and jumping work on slopes.
- The hydrant is visibly faded but readable.
- Only authorized files were edited.

---

# STAGE 2 OF 4 — THE THREE STRONGEST INHABITANTS

Add the Intergalactic Kangaroo, the Infernal, and the Kite.

Each must be discoverable, interactable with E, and able to perform a complete demonstration with a clear recovery.

Use these short dialogue lines unless the existing script requires minor punctuation changes. Do not change their meaning.

## 1. Intergalactic Kangaroo — remembered 1.0

### Design

A kangaroo superhero wearing a black and dark-blue mask and costume.

Give him:

- A clearly recognisable kangaroo silhouette.
- Powerful hind legs.
- A substantial balancing tail.
- Rounded ears with independent secondary motion.
- A readable masked face.
- Dark fabric with visible shading and restrained surface detail.

Keep dark costume areas distinguishable. Do not lose the whole character in black.

His stance should feel confident and balanced. The tail visibly supports changes in posture.

### Dialogue

"Every night, someone dreams I can kick a hole through the stars. So I can."

### Power: two connected galaxy portals

The kangaroo kicks into a small swirling galaxy portal. His foot emerges from a second portal directly in front of the player's camera.

The foot must appear to pass through connected space, not simply duplicate visibly.

### Choreography

*Attention*
He notices the player, adjusts his posture, and gives a small confident head movement.

*Anticipation*
He shifts weight onto his supporting leg. His tail counters the movement. The kicking leg draws back. Ears and costume details lag slightly.

*Portal formation*
A small spiral of luminous dust gathers near the kicking foot's path. It opens into a circular portal with visible depth.

The portal contains layered spiral arms, stars, and dark space. Use differential rotation and subtle distortion rather than a flat spinning texture.

A second portal forms in the player's forward view at a safe distance.

*Kick*
The leg accelerates decisively into the first portal. The corresponding foot emerges from the second with matching orientation and timing.

Use clipping, masking, or another appropriate technique so the limb does not remain fully visible on both sides.

The emerging foot stops short of the camera. It should feel surprising without intersecting the near plane or obscuring the whole scene.

*Recovery*
The foot retracts through the portal. Both openings contract, leaving a few fading particles. He returns his weight to a stable stance.

### Player safety and framing

Do not forcibly rotate the player's view.

Establish the second portal's position from the camera at the start of the action. Do not attach it permanently to the camera like a HUD element.

If the player moves into an unsafe position, adjust or shorten the effect gracefully.

### Hydrant comment

"He never has to wonder whether they'll remember him tomorrow."

## 2. The Infernal — remembered 0.9

### Design

A powerful fire demon with cracked dark skin and molten light beneath.

Use:

- Smooth, intentional anatomy and silhouette.
- Charcoal-like surface roughness.
- Cracks that follow the body rather than looking randomly pasted on.
- Warm emissive light within the cracks.
- Small intermittent embers.
- Heat distortion localized near the hottest areas where supported.

The glow should preserve dark surface detail. Do not make him a uniformly orange luminous blob.

### Dialogue

"They close their eyes, and there I am. A little frightening. Very difficult to forget."

### Power: roaring fire stream

*Anticipation*
He plants his feet, rotates his torso, and draws one arm back. Molten cracks brighten gradually from the torso toward the hand.

*Ignition*
A compact bright flame forms at the emission point. Nearby surfaces receive a brief warm illumination.

*Release*
He projects a sustained stream of fire into a clear demonstration area away from the player, hydrant, and other inhabitants.

The flame should have:

- A bright concentrated core.
- Orange outer tongues.
- Turbulent breakup along its length.
- Embers following the flow.
- A small amount of dissipating smoke.
- Continuous movement away from the source.

Avoid a rigid orange cone or a chain of identical transparent spheres.

*Physical response*
His shoulders and stance react to the release. The emitting hand remains connected to the flame origin throughout the animation.

*Recovery*
The flame shortens and breaks apart. The hand glow fades after the main stream ends. A few embers linger before disappearing.

Use sound with ignition, sustained roar, and decay.

Do not permanently burn or damage the landscape.

### Hydrant comment

"They remember his fire. I think he hopes they remember the rest of him, too."

## 3. The Kite — remembered 0.85

### Design

A living kite with a long ribbon tail.

Give the kite a slightly curved surface, visible edge thickness, subtle material texture, and a convincing supporting structure.

Its idle movement should respond to wind:

- Gentle pitch and yaw.
- Small changes in height.
- Tail movement that travels down its length.
- Delayed response at the ribbon tip.

Do not rotate the entire kite and tail as one rigid object.

### Dialogue

"Someone is always dreaming of flying. Hold on. I'll show you why."

### Power: tornado transport

The Kite summons a tornado that picks up the player and carries them to the other side of the map.

Choose a fixed safe destination on navigable terrain. Do not land inside another character's demonstration area or trigger the Masked Figure automatically.

### Choreography

*Gathering*
The Kite leans into an increasing breeze. Its ribbon draws a broad arc. Nearby lightweight particles begin to orbit.

*Formation*
A funnel grows from a small ground swirl into a coherent moving column.

Use layered airflow ribbons, mist, and sparse lightweight debris. Particles should spiral upward at different rates.

Keep the funnel translucent enough to see the environment.

*Pickup*
Blend the player smoothly from grounded movement into transport. Accelerate upward gently before moving across the map.

*Travel*
Follow a collision-safe curved route. Keep the horizon mostly stable. Let the player look around within comfortable limits.

Do not spin the camera repeatedly or simulate transport by teleporting between positions.

*Landing*
Reduce horizontal speed before descending. Place the player precisely on valid ground, then restore normal gravity and controls.

The wind unwinds and fades. The Kite settles.

### Companion continuity

Ensure the hydrant accompanies or catches up using the existing companion system. He must not remain stranded across the map.

### Hydrant comment

"They let go of the string, but they never quite let go of her."

## Stage 2 checks

Verify all three complete sequences, including repeated use.

Check:

- Portal alignment and limb continuity.
- No foot-camera clipping.
- Fire never emits from a stale world position.
- Tornado transport cannot strand the player.
- Controls restore correctly.
- Hydrant comments occur once after each completed demonstration.
- Temporary effects clean up.
- Simultaneous interactions are prevented.

---

# STAGE 3 OF 4 — THE THREE MORE FADED INHABITANTS

Add Rock Guardian, Water Girl, and Tongue Guy.

Their lower remembered values should affect presentation without making the demonstrations incomplete or difficult to understand.

Their movements should remain expressive. Fading is not the same as broken animation.

## 1. Rock Guardian — remembered 0.6

### Design

A massive, friendly giant made of rocks and green moss.

Use naturally shaped rounded stone masses with believable joints and weight distribution. Do not build him from a stack of identical cubes or spheres.

Differentiate:

- Rough stone.
- Smoother worn edges.
- Crevices.
- Soft moss.
- Small loose fragments.

He has one single eye: fully glowing gold, with a gold iris and NO pupil.

Keep the eye readable without overexposing it.

His idle motion is slow and heavy. Small moss strands respond after larger body movements.

### Dialogue

"They used to dream I could hold up mountains. Some of them still do. Watch your feet."

### Power: ground smash, explosions, and shockwave

*Anticipation*
He lowers his centre of gravity, plants his feet, and lifts his arms. Stone masses shift coherently at the joints.

*Strike*
His arms accelerate downward. Contact with the ground must occur at the exact moment of the impact sound and visual response.

*Impact*
Create a concentrated burst of dust and small fragments at the strike point.

A circular shockwave spreads outward over the terrain. Follow ground elevation rather than passing through hills as a flat floating ring.

Trigger several small outward ground bursts in sequence. They should read as displaced earth and magical force, not unrelated fireballs.

*Camera response*
Apply a short directional impulse based on distance from the impact. Shake decays quickly. Reduced-motion mode removes the shake while preserving sound and visible impact.

*Recovery*
His body absorbs the rebound. He pushes himself upright and settles slowly.

Fragments fall back under gravity and disappear cleanly. Any temporary ground marks must fade; do not permanently break navigation.

### Hydrant comment

"He still tries to make every landing gentle. Even that one."

## 2. Water Girl — remembered 0.45

### Design

Create an original, friendly water-associated character with a clear silhouette.

Use flowing shapes and water-like accents without making the entire character an unreadable transparent blob.

Combine her memory fading with water materials carefully. Avoid layers of transparency that flicker or sort incorrectly.

Her idle animation should suggest buoyancy and continuous small adjustments, with secondary motion in hair or clothing where present.

### Dialogue

"They remember the feeling of floating. My name is harder to keep."

### Power: pool, slide, and water-stream flight

*Pool creation*
She lowers a hand toward the ground. A small wet patch expands smoothly into a shallow pool.

The pool should conform to its demonstration area, remain above the terrain without z-fighting, and have a soft irregular boundary.

Use ripples, reflective highlights, and restrained depth colouring. Do not use a flat opaque blue disc.

*Slide*
She transfers weight onto the pool and glides across it in a clear curved path.

Her pose should bank into the turn. A wake follows her movement, with small droplets peeling away at the edges.

*Lift*
The pool gathers into a rising stream beneath her. The stream visibly supports her upward motion.

Use a coherent curved body of water with animated surface flow, supplemented by spray. Do not create the entire stream from disconnected beads.

*Flight*
She travels through a short graceful airborne arc within the demonstration area.

Water flows backward relative to her movement. Droplets separate, fall, and fade or merge back into the pool.

*Return*
She descends smoothly, the supporting stream collapses into ripples, and she lands without sliding through the ground.

The pool gradually drains or evaporates visually.

### Hydrant comment

"I remember her name. I make a point of it."

## 3. Tongue Guy — remembered 0.3

### Design

Create an original rounded character with an expressive mouth and a tongue designed for an extraordinary extension.

He is more faded than Water Girl but more visible than the hydrant.

Keep the design playful and slightly strange. Avoid gross-out textures, gore, or threatening behaviour.

### Dialogue

"I used to reach the moon. Well... that's how they remember it."

### Power: tongue extending across roughly half the map

*Anticipation*
He leans back slightly, takes a visible breath, and opens his mouth. His stance prepares to counter the extension.

*Extension*
The tongue shoots outward, accelerating before reaching its full length.

Build it as a continuous deforming mesh or curve-based surface with rounded edges, controlled thickness, and a rounded tip.

The tongue should:

- Stay attached to the mouth.
- Follow a smooth path.
- Have a subtle travelling deformation.
- Sag slightly where appropriate.
- Avoid sharp joints and polygonal corners.
- Reach approximately half the map's traversable span.

Use a clear demonstration corridor. Avoid clipping through hills, characters, or the player.

*Hold*
The tongue stays extended briefly. Small damped waves travel toward the tip. The character visibly balances against the reach.

*Retraction*
It retracts smoothly, with a small controlled overshoot and a final facial reaction.

Avoid snapping instantly from maximum length to zero.

Use a restrained elastic sound, not loud comic effects that overpower the atmosphere.

### Hydrant comment

"The distance gets shorter. He still tells the same joke."

## Stage 3 checks

Confirm:

- Memory levels are visually distinguishable.
- Rock Guardian has exactly one gold eye without a pupil.
- Ground effects follow terrain and clean up.
- Water remains readable without transparency glitches.
- Water Girl completes a continuous pool-to-flight-to-landing sequence.
- The tongue is continuous and anchored throughout.
- No demonstration blocks traversal permanently.
- Hydrant comments follow the corresponding action.

---

# STAGE 4 OF 4 — THE MASKED FIGURE AND ENDING HANDOFF

Add the Masked Figure described in section 9 of docs/GAME.md.

This sequence ends by calling ctx.goTo('ending').

Do not implement the ruby shining, error sequence, infinite worlds, final voice line, or any other part owned by ending.js.

## 1. Original character design

The figure is impossibly tall and very thin, entirely black, with long limbs and a plain mask covering his head.

Create an original silhouette.

Use:

- Unnaturally elongated proportions.
- Narrow shoulders and torso.
- Long arms with deliberate joint placement.
- A plain, smooth mask.
- Minimal surface detail.
- A controlled, almost motionless posture.

The black body should feel materially different from the colourful world. Preserve enough silhouette separation to see it against the environment.

Do not add a costume, recognizable franchise features, extra facial details, tentacles, weapons, or new lore.

He is not faded. He does not use the remembered system because he is not from a child's imagination.

## 2. Placement and first sight

Place him somewhere visible through a natural opening in the terrain or along a quieter path. He should be discoverable without introducing a new quest or forcing the player through other demonstrations first.

Trigger the hydrant's first-sight line only when the figure is:

- Within a meaningful viewing distance.
- In the player's field of view.
- Not obscured by terrain.
- Visible for a brief continuous moment.

Do not trigger it merely because the character was added to the scene.

The hydrant says exactly:

"He's unfamiliar."

Play this line once. Preserve the wording and punctuation.

Do not add an explanatory follow-up that identifies the figure.

## 3. Idle animation

Use near-stillness.

A tiny delayed head adjustment or almost imperceptible change in posture is enough. His motion should contrast with the soft, lively world.

Do not use ordinary cheerful breathing or repeated exaggerated swaying.

Do not make him chase, attack, teleport, or scream.

## 4. Interaction

When the player is close enough and looking toward him, display:

Press E to interact

On E:

- Prevent other interactions.
- Suspend normal player movement and mouse look through the existing camera-control system.
- Stop the companion from entering the shot.
- Blend smoothly from the current camera transform into the intended framing.
- Begin the mask-removal sequence.

Avoid an instantaneous camera snap.

If the tall figure does not fit the current view, use a controlled upward framing movement before the reveal.

## 5. Mask removal choreography

*Pause*
Hold briefly after interaction. Allow the stillness to register.

*Reach*
One long arm moves slowly toward the mask. The shoulder, elbow, wrist, and fingers should follow a connected anatomical chain.

*Contact*
The hand reaches and grips the mask before it moves. Prevent the fingers passing visibly through it.

*Separation*
The mask pulls away from the head slowly. A narrow black gap appears first, then expands as the mask clears the face.

*Reveal*
Underneath is only black darkness, with a red ruby gem on his head.

There must be no eyes, mouth, skull, or visible normal face.

*Hold*
The arm moves the mask far enough aside that the camera's route to the ruby is unobstructed.

Keep the mask physically attached to the hand throughout. Do not make it disappear when removed.

## 6. Darkness and ruby

The revealed head interior should read as an absence of normal surface detail.

Do not add swirling galaxies, smoke faces, or another world inside it.

The ruby is a deep red faceted gem. It may reflect existing scene light enough to remain visible.

Do not begin its supernatural shining animation here. That belongs to the ending.

Use enough geometry and material detail that the ruby holds up during the close approach. Avoid a flat red plane or a low-detail object that breaks down when enlarged.

## 7. Camera approach and transition

After the reveal, guide the camera smoothly toward the ruby.

Use a controlled physical dolly with only restrained field-of-view changes if necessary. Do not simulate the entire approach using an extreme zoom.

The movement should:

- Begin gently.
- Build toward the gem.
- Keep the ruby centred.
- Avoid passing through the figure's hand or mask.
- Avoid near-plane clipping.
- End with the ruby filling the screen.

Then call exactly:

ctx.goTo('ending')

Call it once.

Match the existing scene-transition API and lifecycle. If the ending already accepts transition data, use the documented interface; do not invent an incompatible contract.

There must be no visible flash back to Quirkland, default camera frame, duplicated transition, or lingering sound callback.

## 8. Audio and restraint

Gradually lower nearby ambient sound during the reveal if supported by scene-owned audio controls.

Use subtle movement sounds and controlled silence.

Do not add the final deep voice, an error noise sequence, a ruby power-up sound, or a new spoken line.

Those belong to the ending.

## Stage 4 checks

Verify:

- The figure is an original design.
- He is unaffected by memory fading.
- "He's unfamiliar." plays exactly once on actual first sight.
- E requires proximity and looking toward him.
- The hand grips the mask before removing it.
- Only darkness and the red ruby are revealed.
- The camera approaches smoothly.
- The ruby fills the frame without clipping.
- ctx.goTo('ending') runs exactly once.
- No ending content has been implemented in Quirkland.
- Joshua's files remain untouched.

---

# DELIVERY REQUIREMENTS FOR EACH STAGE

Implement only the requested stage, preserving all completed earlier stages.

After implementation, report:

1. What visibly changed.
2. Which authorized files changed.
3. What you actually tested.
4. Any visual approximations or known limitations.
5. Any integration requirement involving a file you are not permitted to edit.

Do not claim the work is complete solely because the code compiles. Where browser testing is available, inspect the environment in motion and test the full relevant interaction.

Prioritize coherent animation, convincing contact, clean transitions, and readable materials over the number of particles or post-processing effects.
