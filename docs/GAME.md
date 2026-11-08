# MASTER GAME DEVELOPMENT PROMPT — LOOP

Create a first-person 3D game called **Loop**. Follow the storyline, environments, characters, mechanics and sequence below exactly. Do not change the story or introduce alternative plot elements.

## 1. Player Controls and First-Person Perspective

- The game must use a first-person perspective.
- WASD controls player movement.
- Mouse movement controls the camera and looking direction.
- SPACE makes the player jump.
- A small white crosshair must remain in the centre of the screen.
- **E is the interaction button throughout Quirkland.**
- When the player approaches an interactable character or object, display the prompt: **"Press E to interact"**.
- Pressing E activates the interaction when the player is close enough and looking towards the relevant character or object.
- Use E to interact with Quirkland's inhabitants, the fire hydrant when appropriate, the holographic globe, the mysterious masked figure and other relevant interactive objects.
- E must not replace the existing movement or jumping controls.
- The golden pressure plate mechanic must still use jumping, not E.

## 2. Opening Scene — The Conveyor Belt

The game begins in a sterile, completely white environment.

The player is standing on a conveyor belt. In front of them, there are babies moving along the conveyor belt and passing through X-ray protective curtains.

The environment should feel clinical, empty and unusual.

There is an overhead sign that reads:

**BACK TO REAL WORLD**

The conveyor belt continues moving forward, and the player eventually reaches their turn.

When it is the player's turn, something goes wrong.

- The overhead sign turns red.
- The entire environment turns red.
- Glitching, corrupted **ERROR!** text appears everywhere.
- The sign changes to **DLROW** (only for the first cut scene).

This should feel like a system malfunction.

## 3. Falling Into the Upside-Down World

After the error, the player passes through the conveyor exit and falls directly into the upside-down London world (section 4), landing on the ceiling.

## 4. Landing in the Inverted World

The player eventually lands on the ceiling of a dark, gloomy, upside-down world.

The environment should have a dark red atmosphere.

Buildings and structures are upside down, and the player is effectively standing on what would normally be the ceiling of the world.

The inverted world is an upside-down London at night: old brick and white-stucco terraced streets, red telephone boxes, red double-decker buses, black taxis, London street signs and Underground roundels, with London landmarks around the city — The Shard, the London Eye, Elizabeth Tower (Big Ben) and The Gherkin. It includes a modern glass Marshall Wace building with its name lit up in large letters on the facade.

The player can explore this environment.

## 5. The Golden Pressure Plate — Flipping Gravity

The player discovers a glowing golden pressure plate: a golden ring on the ground (the right-way-up side of the world), among the buildings. It glows so it can be seen from the ceiling.

While standing on the ceiling, the player must position themselves directly vertically opposite (above) the pressure plate and jump.

When the player jumps in the correct position, their orientation flips, allowing them to stand on the other side.

This mechanic must be reversible: the player can jump again to flip their orientation back.

**Important:** This must be a physical jumping mechanic. Do not replace it with an interaction button or a menu.

## 6. Finding the Holographic Globe

The player explores the inverted world until they discover a holographic Earth globe.

The player approaches the globe and presses **E** to interact.

When they interact with it:

- An error effect occurs.
- The globe transforms into a bright, cheerful miniature Quirkland that looks like a child's imagination: warm, soft rolling hills of bright green grass swaying in the breeze, wobbly paths, round leafy trees, flowers, butterflies, and candy scattered everywhere (lollipops, sweets, candy canes, gumdrops). Above it is a dome "ceiling" in bright childlike colours, covered in many identical big smiling mouths — slightly unsettling. It is warmly lit and a strong contrast to the dark red inverted world. No text is shown.
- Standing on this mini world is a small, friendly red fire hydrant.

The entire inverted world then begins compressing into the globe.

Everything is pulled into it until the world has disappeared.

The camera then zooms smoothly down into the mini world and right into the fire hydrant until it fills the screen, and the player finds themselves in **Quirkland**, where the fire hydrant is.

The whole sequence, from pressing E to arriving in Quirkland, takes about 7–8 seconds.

## 7. Quirkland — Arrival and the Fire Hydrant

The globe transition ends by zooming into the fire hydrant. The camera pulls back and the player is standing right in front of him in **Quirkland**.

### What Quirkland looks like

Quirkland looks like a child's imagination:

- Bright, warm, soft rolling terrain in playful colours — bright green grass, rounded hills and wobbly paths.
- Cartoon-like but smooth and polished. Nothing is blocky: rounded shapes, smooth surfaces and eased animation.
- Candy is scattered across the terrain: lollipops, sweets, candy canes and gumdrops.
- **There is no sky.** Above is a ceiling covered in many identical big smiling mouths, all moving in sync. It should feel slightly unsettling. The rest of the ceiling is a bright, childlike pattern and colour.

### Remembered and faded

Every character in Quirkland has a **remembered** value from 0 to 1 — how much children still think about them.

- The value controls how faded (transparent) and desaturated the character looks.
- The more a child forgets a character, the more they fade and the weaker their ability becomes.
- Strongly remembered characters are bright, solid and powerful.
- The fire hydrant's remembered value is **0.2** — very faded.

### The intro cutscene

A cutscene begins. The fire hydrant explains the story of Quirkland, his ability, why he is faded, and that the stronger inhabitants are bright because children still dream about them. Speaker: "Fire Hydrant". Use these lines exactly:

1. "Oh! A visitor. We haven't had one of those in... well, ever."
2. "Welcome to Quirkland. Everything here was dreamed up by children — every creature, every tree, every gust of wind."
3. "We exist because they imagine us. Air, Fire, Nature, Water — four corners, each one built from their stories."
4. "Me? I'm a fire hydrant. I keep things safe. When fire gets out of hand, I put it out. That's my ability."
5. "But look at me. See how faded I am? Children don't think about fire hydrants anymore."
6. "The more a child forgets you, the more you fade. Your ability weakens. One day... you just aren't here."
7. "The others — the kangaroo, the kite, the infernal one — they're bright and strong. Children still dream about them every night."
8. "Come on. I'll show you around. Stick close — I don't get to talk to anyone new."

## 8. Exploring Quirkland and Meeting Its Inhabitants

After the fire hydrant's cutscene, the player is free to walk around Quirkland.

The fire hydrant becomes the player's companion and follows them around.

The player can approach the inhabitants and press the **E key** to interact with them and other relevant objects.

Each character demonstrates their own ability, and the fire hydrant reacts. The player should be able to explore and discover these abilities through interactions.

### The fire hydrant's ability

Press E on him after the intro:

- "Watch this!" — he sprays a weak, sputtering arc of water that fizzles out halfway.
- "...It used to reach the clouds. Back when they remembered me."

### The cast of inhabitants

Quirkland has seven inhabitants. Details marked *TBD* are still to be decided.

1. **Kite (air)** — "Skye". Bright and strong.
   - E: "Every windy day, a child somewhere runs with a kite. That's what keeps me flying!"
   - Ability: a strong gust lifts the player briefly into the air, then sets them down.
   - Fire Hydrant: "I used to be able to do that with water. Sort of."
2. **Tongue guy** — *TBD* (appearance, remembered value, lines, ability).
3. **Infernal (fire)** — "the infernal one". Bright and strong. *TBD* (lines, ability).
4. **Water girl** — *TBD* (appearance, remembered value, lines, ability).
5. **Intergalactic Kangaroo** — Bright and strong. *TBD* (lines, ability).
6. **Rock Guardian** — *TBD* (appearance, remembered value, lines, ability).
7. **Masked Figure** — see section 9.

## 9. The Mysterious Masked Figure

The Masked Figure is the seventh inhabitant of Quirkland.

While exploring Quirkland, the player encounters a mysterious figure wearing a mask.

When the player first sees him, the fire hydrant reacts and says exactly:

**"He's unfamiliar."**

The player approaches the mysterious figure and presses **E** to interact.

The figure removes its mask.

Instead of a normal face, there is only black darkness, with a ruby visible.

The camera zooms in towards the figure's face and the ruby.

## 10. The Ruby and the Final Error

The ruby begins to shine.

The error animation from the beginning of the game returns.

The camera transitions to a bird's-eye view, revealing an infinite number of worlds.

The screen then turns completely black.

A deep voice says exactly:

**"You will forever be in this loop, you cannot escape"**

The game ends.

## 11. Visual and Audio Direction

The game should maintain the atmosphere described in each section:

- **Opening:** sterile, bright white, clinical and unsettling.
- **Error sequence:** red lighting, visual glitches and repeated glitching, corrupted ERROR! text.
- **Falling sequence:** upside-down London landmarks and a disorientating sense of falling.
- **Inverted world:** dark red, gloomy and upside down.
- **Quirkland:** a world containing the four elements — Air, Fire, Nature and Water.
- **Masked figure:** mysterious, dark and unsettling.
- **Ending:** infinite worlds, darkness and a deep voice.

Use suitable sound effects and environmental audio to support the atmosphere and make each transition feel impactful.

## 12. Development Instructions

Build the game in the exact chronological order described above.

Do not skip scenes, change the order of events, remove characters or replace the described mechanics.

Develop and test each stage before moving on to the next:

1. First-person controller and opening conveyor belt.
2. Error sequence and falling through London.
3. Inverted world and reversible gravity-flipping mechanic.
4. Holographic globe and transition into Quirkland.
5. Fire hydrant introduction and dialogue.
6. Quirkland exploration, inhabitants and abilities.
7. Mysterious masked figure and ruby reveal.
8. Final error sequence and ending.

Ensure that all interactions, movement, jumping, camera transitions, animations and dialogue work correctly.

**The final game must preserve the complete storyline and sequence described in this prompt.**
