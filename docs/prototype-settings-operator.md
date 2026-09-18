# Sprout M2 General and Operator Settings Prototype (Ticket #68)

## Summary

This retained artifact records the first implementation of the bounded General
and Operator Settings surface inside `Manage`. It reuses the accepted #61
shell, tokens, touch floor, status language, and progressive-disclosure
patterns carried through #62, #63, #64, #65, and #66. It preserves ADR-0009
and models the operational contract without adding backend behavior.

The disposable prototype is available through `npm run prototype`. The
interactive surface is intentionally low density: identity and access facts
are primary, while migration, diagnostic, host-boundary, state-matrix, and
owner-review evidence is available on demand.

## 1. Bounded scope

### Covered in Settings

- One operator identity and the private Web access boundary.
- Current browser session inspection, per-session revocation, and revoke-all-
  other-sessions behavior.
- Host-local credential recovery and a risk-gated credential rotation action,
  including the consequence that other browser sessions are invalidated.
- Sprout, Worker protocol, schema, and supported-range compatibility facts.
- Transactional migration guidance, pre-migration safety-copy visibility,
  startup blocking on failure, and host-local recovery guidance.
- Durable-data location guidance and the distinction between a migration guard
  and a backup system.
- Sanitized diagnostic export facts and host-local fallback guidance when Web
  cannot reach the instance.
- A clear split between routine Web operation and host-local administration.
- Normal, loading, warning, unavailable, failure, and risk-bearing state examples.
- Phone and desktop capability parity using the existing Manage shell.

### Explicitly excluded

- Environment recovery and Force Release. Those remain in `Manage / Environments`.
- Onboarding wizard and host bootstrap workflow.
- Web restart, maintenance mode, drain, or scheduled restart controls.
- Backup and restore orchestration, retention scheduling, or disaster-recovery
  governance.
- Multi-Human authorization, roles, invitations, SSO, or public deployment
  governance.
- Production authentication, migration, diagnostics, storage, or API
  implementation.

## 2. Information architecture

The page organizes the operational facts and controls into three cohesive
operator categories accessible via top sub-tabs, with meta review evidence
preserved at the bottom:

1. **Access & Security**:
   - Operator identity and single-operator access boundary facts.
   - Browser session inspection, individual revocation, and revoke-all-other-sessions.
   - Host-local credential recovery guidance and progressive risk-gated rotation.
2. **Instance & System**:
   - Sprout, protocol, and schema compatibility facts with range enforcement.
   - Transactional migration safety copy status, failure visibility, and host recovery.
   - Web routine operations versus host-local administration boundary.
3. **Data & Diagnostics**:
   - Durable data root and database relative location guidance with copy action.
   - Sanitized diagnostic export and host-local offline CLI fallback.
4. **Owner review and state coverage**:
   - Retained ADR decisions, unresolved preferences, and 6-state coverage matrix
     remain available in collapsible review drawers at the bottom.

All foldable containers follow the Sentinel design convention: SVG chevron
icons with smooth 90-degree rotation, right-aligned and vertically centered.
No candidate scenario selector was added to the product canvas.

## 3. Model and state matrix

`OperatorSettingsModel` in `web/src/prototype/types.ts` retains the complete
settings contract: access boundary, browser sessions, credentials, instance
compatibility, migration, durable data, diagnostics, Web and host action
lists, state coverage, and owner review evidence.

| State | Observable example | Operator consequence |
| --- | --- | --- |
| Normal | Authenticated operator, compatible protocol and schema, sanitized export ready | Routine Web operation may continue |
| Loading | Web is checking compatibility or preparing sanitized diagnostics | No destructive action is assumed while facts are pending |
| Warning | Pre-migration safety copy is retained | Treat the copy as a migration guard, not a backup system |
| Unavailable | Web cannot reach Sprout or a schema is outside the supported range | No offline command queue; use host-local guidance |
| Failure | Safety copy creation or migration fails | Preserve the original store, keep startup blocked, recover on the stopped host |
| Risk-bearing | Credential rotation | Other browser sessions are revoked; host-local recovery remains the escape path |

All statuses pair text with semantic border, icon, and badge treatment. No
state depends on color alone.

## 4. ADR-0009 boundary decisions

- Sprout has one operator identity. Multiple desktop and phone browser sessions
  are sessions of that identity, not separate Human accounts.
- Loopback or an operator-managed private network is supported. Public Internet
  exposure is unsupported, and network membership is not Sprout authority.
- Operator credential recovery and rotation happen on the host. Credentials
  have no default value and are never durable URL credentials.
- Agents, Workers, and wake models never receive the operator credential.
- Version mismatch is visible and refused. Sprout does not guess across an
  unsupported protocol or schema range.
- A non-empty durable store receives one consistent local safety copy before a
  supported transactional migration. Failure to create that copy prevents
  migration and serving partially migrated state.
- Durable-data location is documented for host-managed backup. Settings does
  not provide backup or restore commands.
- Web diagnostics are sanitized. Credentials, tokens, provider or account
  identity, hostnames, network addresses, absolute paths, content, private
  reasoning, commands, tool output, and unsanitized stderr are excluded.
- Host-local diagnostics remain available when Web is unreachable.
- Routine Environment and work recovery decisions remain in their authoritative
  Manage surfaces. Settings does not duplicate Force Release.

## 5. Owner review record

### Accepted inheritance

- Reuse the #61 responsive shell, Manage hierarchy, semantic tokens, 44px
  touch floor, keyboard focus, and normal/loading/unavailable/failure language.
- Use the #62 to #66 low-density pattern: primary facts first, details on
  demand, and no duplicate candidate controls.
- Keep Environment recovery and Force Release in `Manage / Environments`.

### Rejected scope

- Flat advanced-settings dashboard with every control open.
- Web restart, maintenance, backup, restore, or onboarding controls.
- Multi-Human authorization and public deployment governance.
- Raw diagnostic logs or a content-rich opt-in export.
- Credential or host-network details in the Web surface.

### Unresolved owner preferences

- Final fourth-tab label: `Settings` versus `General`.
- Whether state-coverage evidence should be visible in a normal review drawer or
  only in the retained artifact.
- Final wording and interaction treatment for credential rotation confirmation.

The UI marks this record **Pending owner review** and does not claim that these
preferences have been accepted. The retained artifact path is
`docs/prototype-settings-operator.md`.

## 6. Verification contract

The focused DOM suite covers identity/access facts, session revocation,
credential risk gating and consequences, compatibility and migration failure
visibility, durable-data guidance, sanitized diagnostic boundaries, host-local
fallback, Web versus host-local copy, state coverage, phone/desktop navigation,
and the retained review record. The implementation is a decision artifact only;
production persistence, authentication, migration, and export contracts remain
downstream work.
