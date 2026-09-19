---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, or applications. Generates creative, polished code that avoids generic AI aesthetics.
license: Complete terms in LICENSE.txt
---

# Frontend Design

Create working interfaces with a deliberate aesthetic suited to their audience. The caller
owns implementation approval, file scope, and validation; this skill owns design choices.

## Design Thinking

<!-- adapted from mattpocock/skills (MIT) -->
Before coding, inspect the existing design system and choose a clear direction:
- Purpose: the user's task, audience, and primary action.
- Tone: editorial, industrial, playful, organic, refined, brutalist, or another coherent
  direction grounded in the product rather than a repeated default style.
- Constraints: framework, existing components, performance, accessibility, and brand.
- Differentiation: one memorable detail that serves the experience.

For an established product, evolve its visual language. For a new surface, commit to the
chosen direction: both expressive maximalism and restrained minimalism need precision.
Done when purpose, hierarchy, constraints, and the intended visual character are explicit.

## Frontend Aesthetics Guidelines

- Typography: pair a characterful display face with a readable body face where appropriate;
  respect existing brand fonts. Tune scale, weight, line height, and measure for hierarchy.
- Color and theme: use shared tokens or CSS variables, purposeful dominant colors, and
  focused accents. Choose palettes for the content and contrast requirements.
- Composition: use grids, asymmetry, overlap, generous space, or controlled density with
  intent. Keep reading order and the primary action clear across viewport sizes.
- Motion: concentrate effects on meaningful transitions and feedback. Prefer CSS for
  simple motion and existing animation tools for complex sequences; honor reduced motion.
- Backgrounds and detail: textures, gradients, geometric forms, shadows, and layered
  surfaces can establish atmosphere when they reinforce the chosen direction.

Use context-specific combinations rather than formulaic font, gradient, and card layouts.
Match complexity to the aesthetic: expressive designs justify richer effects; refined
designs depend on exact spacing, typography, and subtle details.

## Interaction and Accessibility

Implement real interactions with semantic controls, clear labels, visible focus, keyboard
access, and meaningful feedback. Provide loading, empty, error, success, and disabled states
where relevant; make recovery understandable. Use sufficient contrast, suitable targets,
and layouts that accommodate zoom, small screens, and longer content.
Reuse the project's component patterns and tokens so visual polish remains maintainable.
Done when the intended journey and its failure states are implemented within caller scope.

## Design Review

Inspect the complete composition and key states at representative viewport sizes using
caller-authorized tools. Check hierarchy, spacing, legibility, focus, motion preferences,
and interaction feedback. Report unobserved runtime behavior as a verification gap.
Done when the interface is coherent, the required journey has evidence, and any remaining
visual or interaction limitations are explicit in the caller's implementation report.
