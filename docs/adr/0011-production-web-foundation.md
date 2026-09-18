---
status: accepted
---

# Production Web uses Vue and an owned Tailwind UI system

The owner-accepted #61–#68 prototype is the Production Web structural
baseline: production substantially preserves its information architecture,
responsive hierarchy, navigation, drill-down, action placement, state
presentation, and interaction flow. Its fixture-backed browser state, direct
DOM rendering, CSS organization, prototype harness, review controls, and
Ticket/ADR copy are not an implementation baseline.

Sprout's production Web foundation uses stable Vue 3.5 Single-File Components
with TypeScript and Vite. Vue Router owns URL-addressable navigation and browser
history. Pinia owns only bounded cross-page UI state; authoritative Project,
Task, Message, Environment, Agent, Usage, lease, routing, and recovery facts
remain backend-owned and reach the UI through typed ports and transport
adapters. View-local interaction state remains local to its Vue Module rather
than accumulating in one global browser store.

The UI system uses Tailwind CSS 4 through its first-party Vite integration and
CSS-first theme variables. Reka UI supplies headless accessible interaction
primitives, and shadcn-vue source may be adopted selectively into the
repository. External UI code supplies behaviours such as focus management,
keyboard interaction, dialogs, popovers, menus, and selection; Sprout remains
authoritative over tokens, density, status language, domain templates, page
composition, and phone/desktop structure.

Convergent card, list, detail, form, and overlay behaviour is factored into
shared deep Modules, while Environment, Message, Attention, Task, Agent, and
other domain Modules retain their own meaning and actions. Sprout does not use
one universal conditional Card, adopt several overlapping full UI frameworks,
or publish a general-purpose UI package before a second real consumer exists.

Vue 3.6 Vapor prereleases were considered and rejected for this foundation.
Their prerelease versions are not accepted by the current peer ranges of the
selected Router, state, and UI dependencies. Any later Vapor adoption requires
separate compatibility evidence and must preserve the caller-facing Module
interfaces rather than forcing the rest of the application to depend on an
experimental renderer.

## Reference check

The standing Web references were consulted at pinned revisions. Paperclip at
`352153b5edf02ff4262210c7bd5bfa94bcf37c7c` uses React, Tailwind CSS 4, and
headless accessible primitives whose source is composed into its own UI;
Sprout adopts the Tailwind-plus-owned-UI-system shape, not its React code.
Cumora at `ae18eff5d351f9a666984a2a03f13428d8f714fc` also uses React and
Tailwind, while AionUi at `6744099b279b991c17e31c243f0920477bd31cb6`
uses React with the styled Arco Design system. Those framework implementations
are not portable to Vue, and AionUi's externally owned visual language conflicts
with Sprout's accepted structural and state language. No reference code is
copied by this decision.

## Consequences

- Map #70 validates the decision with the production Shell and Manage /
  Environments structural slice before `/to-spec` commits every view to it.
- Prototype code is mined for structure and design decisions, not incrementally
  promoted as the production domain or state layer.
- Prototype-only harnesses, fixture selectors, review drawers, and development
  provenance are removed from production surfaces.
- M1 cleanup remains behaviour-preserving. New M2 backend contracts and product
  capabilities belong in the later specification and implementation Tickets.
