# Ticket #112: M2 production evidence and isolated dogfood

This record submits AC1–AC4 evidence for review at base `8bf22088`. The mandatory first command, `git log --oneline -1`, returned the required #111 integration commit. **AC5, explicit product-owner acceptance, remains pending.** This document does not accept #112, close #77, or replace pending page acceptance with a Worker verdict.

The pass used the production runtime composition, SQLite adapters, authenticated HTTP/CSRF routes, real CLI enrollment and foreground Workers, real Pi turns, and the built production Web. It used separate temporary databases, identity/state, workspaces, and browser profile; listeners used only the assigned isolated allocation. No preview service, preview database, shared Worker daemon, or default Worker state was controlled. Host engine authentication was reused through the engine's normal local interface; credentials were never copied into this document or the repository.

## AC1: outcome-to-production map

The issue landscape was fetched with `gh issue list --state all --limit 300`. Every M2-01–M2-34 ticket (#78–#111), the eight requested supplementary tickets, #112's acceptance, and parent #77 were read, including their comments. The table below covers **42 supporting tickets**. The requested closed set and merged-awaiting-acceptance set are both represented; older foundational tickets are included as well.

| Supporting outcome | Production Modules and pages establishing it | Objective evidence and remaining acceptance |
| --- | --- | --- |
| M2-O1: product-managed collaboration setup | Foundations #78–#86; enrollment/readiness #87; Environments #89; Agent identity/options #90 and Agents #91/#183; Project/template/membership #92; access/workspaces #93; Overview #94; scopes/Working groups #95 | Verified integration objects and PASS/repair records below; live creation of two reusable Agents, three Projects, grants, and a Working group in this pass. Closed tracker state is recorded separately from any explicit Human verdict. |
| M2-O2: Human-authorized Agent work | Proposals #99; begin/advancement #100; intervention/validation/end/recovery #101; Tasks #102; durable-Agent and recovery fixes integrated through #111 | #99–#101 closed; #102 and #111 owner gates pending. Real proposal-backed Tasks in three contexts, plus fresh enrolled-Worker active-run recovery below. |
| M2-O3: intentional, explainable routing | Scopes #95; deterministic routing #96; assisted batches #97; Chat #98/#184; failure evidence #180/#182; bounded reconnect #181; sanitization research/decision #178/#179 | Final review trails below; live deterministic mention, durable causal evidence, duplicate delivery suppression, non-routing reply, and phone message. #98/#180 owner acceptance pending. #179 is an owner risk decision, **not a complete secret-removal implementation**. |
| M2-O4: supported self-hosted operation | Enrollment/readiness #87; recovery/Force Release #88; Environments #89; diagnostics #108; Settings #109; platform validation #111 | [macOS enrollment evidence](live-macos-enrollment-to-run.md), [Windows enrollment evidence](live-windows-enrollment-to-run.md), and [#111 validation](ticket-111-local-operator-validation.md), including their preserved blocked attempts and later addenda. This pass adds same-identity active-turn recovery; it does not repeat Windows operation or Force Release. #111's owner acceptance and Windows shutdown re-observation remain pending. |
| M2-O5: truthful Usage and cost | Observations #105; aggregation/routing usage #106; Usage page #107 | Review/repair records below; live work-model telemetry, unavailable interrupted telemetry, separate routing subtotal, and phone backing table. #107 owner acceptance pending. F2–F4 below delimit what the observed cost and metadata establish. |
| M2-O6: mobile operator control | Shell #86/#185; Environments #89; Agents #91/#183; Overview #94; Chat #98/#184; Tasks #102; Feed #103/#104; Usage #107; Settings #109; cross-page integration #110 | #110's mounted 390px/1440px production journeys and PASS trail; actual 390px browser sign-in, Feed/Manage navigation, Usage/Settings inspection, and Chat send in this pass. Several page owner gates remain open; this is not a full touch-device/state-matrix replay. |
| M2-O7: dogfooded Local Operator MVP | This #112 record composes the preceding outcomes | Sprout source inspection, a lightweight game implementation/review, Unity source/Editor compilation, interruption/recovery, and phone operation are separate evidence. Findings are disposed below. **Overall Human acceptance remains pending.** |

### Reading the ticket ledger

Each integration object was resolved with Git before citation; each cited issue-comment URL came from its issue's fetched comments. Earlier generation integration objects may be historical objects retained across the foundation's integration history; they are not represented as new commits made on this branch. The hash plus durable merge record identifies that history without assuming a remote commit URL exists. Local evidence paths were opened before linking them.

PASS links establish the automated verdict for their reviewed scope. Prior FAIL and repair/evidence links preserve closure trails rather than erasing earlier failures. Where the last review is narrow, the merge record carries the cumulative chain: notably #98, #102, #104, #107, and #111. #185's final review was explicitly waived by the driver and replaced by owner verification; no final PASS is invented. #178 is accepted research. #179 was closed because the owner superseded its original outcome.

Counters are **reported historical observations**, not fresh #112 test runs, and are never summed across revisions. A failed or inconsistent historical split remains visible; the linked record describes its interpretation. In particular #167 and reconnect-crash attribution remain **UNDETERMINED per the standing a43 classification**. A PASS review is not a promise that every historical suite attempt was green.

| Ticket and production responsibility | Tracker state | Verified integration object and record | Review and finding-closure trail | Reported historical counters |
| --- | --- | --- | --- | --- |
| [#78](https://github.com/tinysnake/sprout/issues/78) — extract stable Web projections and wire contracts | Closed | `420ab663` · [record](https://github.com/tinysnake/sprout/issues/78#issuecomment-5742182102) | [PASS](https://github.com/tinysnake/sprout/issues/78#issuecomment-5742158791) · [repair/evidence](https://github.com/tinysnake/sprout/issues/78#issuecomment-5742085798) | 46/46; 559/559; 37/37 |
| [#79](https://github.com/tinysnake/sprout/issues/79) — extract typed host configuration | Closed | `fbc0beac` · [record](https://github.com/tinysnake/sprout/issues/79#issuecomment-5742360740) | [PASS](https://github.com/tinysnake/sprout/issues/79#issuecomment-5742337832) · [prior FAIL](https://github.com/tinysnake/sprout/issues/79#issuecomment-5742153605) · [repair/evidence](https://github.com/tinysnake/sprout/issues/79#issuecomment-5742231912) | 109/109; 619/619 |
| [#80](https://github.com/tinysnake/sprout/issues/80) — extract the Environment Worker factory | Closed | `156ad583` · [record](https://github.com/tinysnake/sprout/issues/80#issuecomment-5742498270) | [PASS](https://github.com/tinysnake/sprout/issues/80#issuecomment-5742486722) · [repair/evidence](https://github.com/tinysnake/sprout/issues/80#issuecomment-5742308257) | 251/251; 646/646 |
| [#81](https://github.com/tinysnake/sprout/issues/81) — rehome SQLite adapters by domain | Closed | `f6f9291d` · [record](https://github.com/tinysnake/sprout/issues/81#issuecomment-5743273474) | [PASS](https://github.com/tinysnake/sprout/issues/81#issuecomment-5743265483) · [prior FAIL](https://github.com/tinysnake/sprout/issues/81#issuecomment-5742747238) · [repair/evidence](https://github.com/tinysnake/sprout/issues/81#issuecomment-5743082331) | 132/132; 666/666; 68/68 |
| [#82](https://github.com/tinysnake/sprout/issues/82) — create a testable Sprout runtime composition | Closed | `45af3acd` · [record](https://github.com/tinysnake/sprout/issues/82#issuecomment-5742838111) | [PASS](https://github.com/tinysnake/sprout/issues/82#issuecomment-5742824252) · [repair/evidence](https://github.com/tinysnake/sprout/issues/82#issuecomment-5742690623) | 10/10; 656/656 |
| [#83](https://github.com/tinysnake/sprout/issues/83) — add schema versioning and migration safety | Closed | `8a9f3b5f` · [record](https://github.com/tinysnake/sprout/issues/83#issuecomment-5744246627) | [PASS](https://github.com/tinysnake/sprout/issues/83#issuecomment-5744235389) · [prior FAIL](https://github.com/tinysnake/sprout/issues/83#issuecomment-5743943380) · [repair/evidence](https://github.com/tinysnake/sprout/issues/83#issuecomment-5744100442) | 113/113; 684/684 |
| [#84](https://github.com/tinysnake/sprout/issues/84) — establish operator identity and browser sessions | Closed | `00381b30` · [record](https://github.com/tinysnake/sprout/issues/84#issuecomment-5746302058) | [PASS](https://github.com/tinysnake/sprout/issues/84#issuecomment-5746292614) · [prior FAIL](https://github.com/tinysnake/sprout/issues/84#issuecomment-5746203229) · [repair/evidence](https://github.com/tinysnake/sprout/issues/84#issuecomment-5746243994) | 695 passed / 0 failed |
| [#85](https://github.com/tinysnake/sprout/issues/85) — establish production API transport and browser adapters | Closed | `449b7565` · [record](https://github.com/tinysnake/sprout/issues/85#issuecomment-5747116118) | [PASS](https://github.com/tinysnake/sprout/issues/85#issuecomment-5747116118) · [prior FAIL](https://github.com/tinysnake/sprout/issues/85#issuecomment-5746755234) · [repair/evidence](https://github.com/tinysnake/sprout/issues/85#issuecomment-5747017462) | 131/131; 711/711 |
| [#86](https://github.com/tinysnake/sprout/issues/86) — deliver the Production Web Shell and shared UI foundation | Closed | `6450d052` · [record](https://github.com/tinysnake/sprout/issues/86#issuecomment-5748435097) | [PASS](https://github.com/tinysnake/sprout/issues/86#issuecomment-5748427967) · [prior FAIL](https://github.com/tinysnake/sprout/issues/86#issuecomment-5748299285) · [repair/evidence](https://github.com/tinysnake/sprout/issues/86#issuecomment-5748363393) | 53/53; 13/13; 758/758 |
| [#87](https://github.com/tinysnake/sprout/issues/87) — deliver Environment enrollment and readiness | Closed | `30e0a0ee` · [record](https://github.com/tinysnake/sprout/issues/87#issuecomment-5750009411) | [PASS](https://github.com/tinysnake/sprout/issues/87#issuecomment-5749997899) · [prior FAIL](https://github.com/tinysnake/sprout/issues/87#issuecomment-5749997899) · [repair/evidence](https://github.com/tinysnake/sprout/issues/87#issuecomment-5749938936) | 208/208; 844/844; 222/222 |
| [#88](https://github.com/tinysnake/sprout/issues/88) — deliver Environment reconciliation, recovery, and Force Release | Closed | `93a0ca40` · [record](https://github.com/tinysnake/sprout/issues/88#issuecomment-5750704234) | [PASS](https://github.com/tinysnake/sprout/issues/88#issuecomment-5750689475) · [repair/evidence](https://github.com/tinysnake/sprout/issues/88#issuecomment-5750418752) | 867/867 |
| [#89](https://github.com/tinysnake/sprout/issues/89) — deliver the Manage Environments page | Closed | `1fa416ce` · [record](https://github.com/tinysnake/sprout/issues/89#issuecomment-5751927637) | [PASS](https://github.com/tinysnake/sprout/issues/89#issuecomment-5751915277) · [prior FAIL](https://github.com/tinysnake/sprout/issues/89#issuecomment-5751925131) · [repair/evidence](https://github.com/tinysnake/sprout/issues/89#issuecomment-5751825629) | 901/901 integration |
| [#90](https://github.com/tinysnake/sprout/issues/90) — deliver Agent identity and ordered work options | Closed | `023991b3` · [record](https://github.com/tinysnake/sprout/issues/90#issuecomment-5752574862) | [PASS](https://github.com/tinysnake/sprout/issues/90#issuecomment-5752566076) · [repair/evidence](https://github.com/tinysnake/sprout/issues/90#issuecomment-5752491678) | 941/941 integration |
| [#91](https://github.com/tinysnake/sprout/issues/91) — deliver the Manage Agents page | Closed | `80860eb6` · [record](https://github.com/tinysnake/sprout/issues/91#issuecomment-5754707560) | [PASS](https://github.com/tinysnake/sprout/issues/91#issuecomment-5754683510) · [prior FAIL](https://github.com/tinysnake/sprout/issues/91#issuecomment-5754701884) · [repair/evidence](https://github.com/tinysnake/sprout/issues/91#issuecomment-5754549927) | 985/985 |
| [#92](https://github.com/tinysnake/sprout/issues/92) — deliver Project, template, and membership authority | Closed | `61b10249` · [record](https://github.com/tinysnake/sprout/issues/92#issuecomment-5757954311) | [PASS](https://github.com/tinysnake/sprout/issues/92#issuecomment-5757903331) · [prior FAIL](https://github.com/tinysnake/sprout/issues/92#issuecomment-5757780006) · [repair/evidence](https://github.com/tinysnake/sprout/issues/92#issuecomment-5757763200) | 1019 passed / 0 failed |
| [#93](https://github.com/tinysnake/sprout/issues/93) — deliver Project Environment access and workspaces | Closed | `5d4a675c` · [record](https://github.com/tinysnake/sprout/issues/93#issuecomment-5763025684) | [PASS](https://github.com/tinysnake/sprout/issues/93#issuecomment-5762968951) · [prior FAIL](https://github.com/tinysnake/sprout/issues/93#issuecomment-5762811287) · [repair/evidence](https://github.com/tinysnake/sprout/issues/93#issuecomment-5762787027) | 1073 passed / 0 failed |
| [#94](https://github.com/tinysnake/sprout/issues/94) — deliver the Project Overview page | Closed | `365a6c2e` · [record](https://github.com/tinysnake/sprout/issues/94#issuecomment-5888148554) | [PASS](https://github.com/tinysnake/sprout/issues/94#issuecomment-5888129850) · [prior FAIL](https://github.com/tinysnake/sprout/issues/94#issuecomment-5887763294) · [repair/evidence](https://github.com/tinysnake/sprout/issues/94#issuecomment-5887004516) | 13/13 |
| [#95](https://github.com/tinysnake/sprout/issues/95) — deliver Working groups and conversation scopes | Closed | `3d448b32` · [record](https://github.com/tinysnake/sprout/issues/95#issuecomment-5887087472) | [PASS](https://github.com/tinysnake/sprout/issues/95#issuecomment-5877910197) · [prior FAIL](https://github.com/tinysnake/sprout/issues/95#issuecomment-5876967421) · [repair/evidence](https://github.com/tinysnake/sprout/issues/95#issuecomment-5877681989) | 1614/1615; 1615/1615; 1606/1606 |
| [#96](https://github.com/tinysnake/sprout/issues/96) — deliver Messages, Project events, and deterministic routing | Closed | `278f73cc` · [record](https://github.com/tinysnake/sprout/issues/96#issuecomment-5891267652) | [PASS](https://github.com/tinysnake/sprout/issues/96#issuecomment-5891102958) · [prior FAIL](https://github.com/tinysnake/sprout/issues/96#issuecomment-5890825803) · [repair/evidence](https://github.com/tinysnake/sprout/issues/96#issuecomment-5890963741) | 1675/1675 |
| [#97](https://github.com/tinysnake/sprout/issues/97) — deliver wake-model-assisted routing batches | Closed | `82be36d5` · [record](https://github.com/tinysnake/sprout/issues/97#issuecomment-5902271461) | [PASS](https://github.com/tinysnake/sprout/issues/97#issuecomment-5902245206) · [prior FAIL](https://github.com/tinysnake/sprout/issues/97#issuecomment-5894785549) · [repair/evidence](https://github.com/tinysnake/sprout/issues/97#issuecomment-5902143780) | See linked review/work record |
| [#98](https://github.com/tinysnake/sprout/issues/98) — deliver the Project Chat page | Merged; owner acceptance pending | `0f3ed2da` · [record](https://github.com/tinysnake/sprout/issues/98#issuecomment-5908034563) | [PASS](https://github.com/tinysnake/sprout/issues/98#issuecomment-5907967678) · [prior FAIL](https://github.com/tinysnake/sprout/issues/98#issuecomment-5907293777) · [repair/evidence](https://github.com/tinysnake/sprout/issues/98#issuecomment-5907499703) | 1759 passed / 0 failed |
| [#99](https://github.com/tinysnake/sprout/issues/99) — deliver Task proposals and content versions | Closed | `16531b3d` · [record](https://github.com/tinysnake/sprout/issues/99#issuecomment-5917796147) | [PASS](https://github.com/tinysnake/sprout/issues/99#issuecomment-5917759117) · [prior FAIL](https://github.com/tinysnake/sprout/issues/99#issuecomment-5917185055) · [repair/evidence](https://github.com/tinysnake/sprout/issues/99#issuecomment-5917515164) | 1833/1833; 1832/1832; 1831/1832 |
| [#100](https://github.com/tinysnake/sprout/issues/100) — deliver Human-authorized Task begin and Task-lead advancement | Closed | `9b574bd8` · [record](https://github.com/tinysnake/sprout/issues/100#issuecomment-5924681399) | [PASS](https://github.com/tinysnake/sprout/issues/100#issuecomment-5924513143) · [prior FAIL](https://github.com/tinysnake/sprout/issues/100#issuecomment-5924240331) · [repair/evidence](https://github.com/tinysnake/sprout/issues/100#issuecomment-5923749642) | 27/27; 1847/1847; 1559/1560 |
| [#101](https://github.com/tinysnake/sprout/issues/101) — deliver Task intervention, validation, safe end, and recovery | Closed | `d9f935e2` · [record](https://github.com/tinysnake/sprout/issues/101#issuecomment-5937053405) | [PASS](https://github.com/tinysnake/sprout/issues/101#issuecomment-5936566116) · [prior FAIL](https://github.com/tinysnake/sprout/issues/101#issuecomment-5935063718) · [repair/evidence](https://github.com/tinysnake/sprout/issues/101#issuecomment-5936175458) | 72/72; 1872/1872; 69/69 |
| [#102](https://github.com/tinysnake/sprout/issues/102) — deliver the Project Tasks page | Merged; owner acceptance pending | `e8052b43` · [record](https://github.com/tinysnake/sprout/issues/102#issuecomment-5945665649) | [PASS](https://github.com/tinysnake/sprout/issues/102#issuecomment-5945619359) · [prior FAIL](https://github.com/tinysnake/sprout/issues/102#issuecomment-5938214238) · [repair/evidence](https://github.com/tinysnake/sprout/issues/102#issuecomment-5945441916) | 66/66; 1633/1635; 411/411 |
| [#103](https://github.com/tinysnake/sprout/issues/103) — project Human Attention and operational activity | Merged; owner acceptance pending | `575f6379` · [record](https://github.com/tinysnake/sprout/issues/103#issuecomment-5938397600) | [PASS](https://github.com/tinysnake/sprout/issues/103#issuecomment-5938246257) · [prior FAIL](https://github.com/tinysnake/sprout/issues/103#issuecomment-5937303960) · [repair/evidence](https://github.com/tinysnake/sprout/issues/103#issuecomment-5937743004) | 29/29; 1553/1553; 343/343 |
| [#104](https://github.com/tinysnake/sprout/issues/104) — deliver the Feed and Attention page | Merged; owner acceptance pending | `ac097f6f` · [record](https://github.com/tinysnake/sprout/issues/104#issuecomment-5947439368) | [PASS](https://github.com/tinysnake/sprout/issues/104#issuecomment-5947336529) · [prior FAIL](https://github.com/tinysnake/sprout/issues/104#issuecomment-5946816410) · [repair/evidence](https://github.com/tinysnake/sprout/issues/104#issuecomment-5947068594) | 1636/1637; 415/415; 23/23 |
| [#105](https://github.com/tinysnake/sprout/issues/105) — record truthful Usage observations | Closed | `c7e45577` · [record](https://github.com/tinysnake/sprout/issues/105#issuecomment-5919038984) | [PASS](https://github.com/tinysnake/sprout/issues/105#issuecomment-5918872001) · [prior FAIL](https://github.com/tinysnake/sprout/issues/105#issuecomment-5917618267) · [repair/evidence](https://github.com/tinysnake/sprout/issues/105#issuecomment-5918308313) | 1867/1867; 1846/1846 |
| [#106](https://github.com/tinysnake/sprout/issues/106) — aggregate Usage and account for routing-model activity | Closed | `b9e77a6a` · [record](https://github.com/tinysnake/sprout/issues/106#issuecomment-5937055293) | [PASS](https://github.com/tinysnake/sprout/issues/106#issuecomment-5923420582) · [prior FAIL](https://github.com/tinysnake/sprout/issues/106#issuecomment-5922926416) · [repair/evidence](https://github.com/tinysnake/sprout/issues/106#issuecomment-5923215484) | 20/20; 12/12; 32/32 |
| [#107](https://github.com/tinysnake/sprout/issues/107) — deliver the Manage Usage and Costs page | Merged; owner acceptance pending | `e92faef5` · [record](https://github.com/tinysnake/sprout/issues/107#issuecomment-5940578064) | [PASS](https://github.com/tinysnake/sprout/issues/107#issuecomment-5940499921) · [prior FAIL](https://github.com/tinysnake/sprout/issues/107#issuecomment-5939767965) · [repair/evidence](https://github.com/tinysnake/sprout/issues/107#issuecomment-5940244679) | 67/67; 1606/1606; 384/384 |
| [#108](https://github.com/tinysnake/sprout/issues/108) — deliver sanitized diagnostics and operator settings | Closed | `10c41465` · [record](https://github.com/tinysnake/sprout/issues/108#issuecomment-5918028970) | [PASS](https://github.com/tinysnake/sprout/issues/108#issuecomment-5917800156) · [prior FAIL](https://github.com/tinysnake/sprout/issues/108#issuecomment-5917072101) · [repair/evidence](https://github.com/tinysnake/sprout/issues/108#issuecomment-5917471217) | 1840/1840; 56/56; 1826/1826 |
| [#109](https://github.com/tinysnake/sprout/issues/109) — deliver the Manage Settings page | Closed | `417671ad` · [record](https://github.com/tinysnake/sprout/issues/109#issuecomment-5920109082) | [PASS](https://github.com/tinysnake/sprout/issues/109#issuecomment-5920073949) · [prior FAIL](https://github.com/tinysnake/sprout/issues/109#issuecomment-5919689769) · [repair/evidence](https://github.com/tinysnake/sprout/issues/109#issuecomment-5919948786) | 1882/1882; 30/30; 1854/1854 |
| [#110](https://github.com/tinysnake/sprout/issues/110) — verify cross-page production integration | Merged; owner acceptance pending | `309657cd` · [record](https://github.com/tinysnake/sprout/issues/110#issuecomment-5943976391) | [PASS](https://github.com/tinysnake/sprout/issues/110#issuecomment-5943947479) · [prior FAIL](https://github.com/tinysnake/sprout/issues/110#issuecomment-5943694028) · [repair/evidence](https://github.com/tinysnake/sprout/issues/110#issuecomment-5943830866) | 95/95; 1634/1634; 408/408 |
| [#111](https://github.com/tinysnake/sprout/issues/111) — validate supported macOS and Windows operation | Merged; owner acceptance pending | `8bf22088` · [record](https://github.com/tinysnake/sprout/issues/111#issuecomment-5947897787) | [PASS](https://github.com/tinysnake/sprout/issues/111#issuecomment-5947834733) · [prior FAIL](https://github.com/tinysnake/sprout/issues/111#issuecomment-5947115291) · [repair/evidence](https://github.com/tinysnake/sprout/issues/111#issuecomment-5947504550) | 1640/1640; 415/415; 19/19 |
| [#178](https://github.com/tinysnake/sprout/issues/178) — Research: sanitize secrets and sensitive data before model or log export | Closed | `3063ff5a` · [record](https://github.com/tinysnake/sprout/issues/178#issuecomment-5901398598) | [Research accepted](https://github.com/tinysnake/sprout/issues/178#issuecomment-5901398598) · [repair/evidence](https://github.com/tinysnake/sprout/issues/178#issuecomment-5901383346) | Research; application tests not applicable |
| [#179](https://github.com/tinysnake/sprout/issues/179) — Follow-up: complete sensitive-data sanitization for routing-context export (deferred) | Closed | No production merge: superseded by owner | [Owner superseded outcome](https://github.com/tinysnake/sprout/issues/179#issuecomment-5945414346) | Owner decision; application tests not applicable |
| [#180](https://github.com/tinysnake/sprout/issues/180) — Follow-up: surface run-lifecycle failures as system Project events and message evidence | Merged; owner acceptance pending | `cb376fa6` · [record](https://github.com/tinysnake/sprout/issues/180#issuecomment-5910233580) | [PASS](https://github.com/tinysnake/sprout/issues/180#issuecomment-5910153485) · [prior FAIL](https://github.com/tinysnake/sprout/issues/180#issuecomment-5909414962) · [repair/evidence](https://github.com/tinysnake/sprout/issues/180#issuecomment-5909839618) | 1773 passed / 0 failed |
| [#181](https://github.com/tinysnake/sprout/issues/181) — Bounded retry: re-admit environment-disconnected Agent runs on first Project Environment reconnect | Closed | `ce0310c7` · [record](https://github.com/tinysnake/sprout/issues/181#issuecomment-5909473009) | [PASS](https://github.com/tinysnake/sprout/issues/181#issuecomment-5909420906) · [prior FAIL](https://github.com/tinysnake/sprout/issues/181#issuecomment-5908909038) · [repair/evidence](https://github.com/tinysnake/sprout/issues/181#issuecomment-5909161205) | 1793/1793 integration |
| [#182](https://github.com/tinysnake/sprout/issues/182) — Bug: engine turns that end with an error are recorded as completed runs (silent failure) | Closed | `eaaf4f6f` · [record](https://github.com/tinysnake/sprout/issues/182#issuecomment-5936468481) | [PASS](https://github.com/tinysnake/sprout/issues/182#issuecomment-5936367270) · [prior FAIL](https://github.com/tinysnake/sprout/issues/182#issuecomment-5925039317) · [repair/evidence](https://github.com/tinysnake/sprout/issues/182#issuecomment-5935837939) | 1571/1570; 383/383; 1954/1953 |
| [#183](https://github.com/tinysnake/sprout/issues/183) — Manage Agents: add an Edit action for ordered work options (story 37: reorder AND edit) | Closed | `d1e38e3f` · [record](https://github.com/tinysnake/sprout/issues/183#issuecomment-5909042323) | [PASS](https://github.com/tinysnake/sprout/issues/183#issuecomment-5908979348) · [prior FAIL](https://github.com/tinysnake/sprout/issues/183#issuecomment-5908634581) · [repair/evidence](https://github.com/tinysnake/sprout/issues/183#issuecomment-5908832045) | 1,761/1,761; 1761/1761; 10/10 |
| [#184](https://github.com/tinysnake/sprout/issues/184) — Project Chat: render Agent replies to human messages on the live path (functional reply evidence) | Closed | `ddeac0dd` · [record](https://github.com/tinysnake/sprout/issues/184#issuecomment-5913079525) | [PASS](https://github.com/tinysnake/sprout/issues/184#issuecomment-5910865764) · [prior FAIL](https://github.com/tinysnake/sprout/issues/184#issuecomment-5909159077) · [repair/evidence](https://github.com/tinysnake/sprout/issues/184#issuecomment-5910520276) | 1819/1819 integration |
| [#185](https://github.com/tinysnake/sprout/issues/185) — Connection truthfulness: reads are not connection facts, fetches do not fabricate liveness, real SSE heartbeat keeps quiet streams fresh | Closed | `79888994` · [record](https://github.com/tinysnake/sprout/issues/185#issuecomment-5915853133) | [Waiver and rework](https://github.com/tinysnake/sprout/issues/185#issuecomment-5915853133) · [owner acceptance](https://github.com/tinysnake/sprout/issues/185#issuecomment-5915891655) | 1819 passed / 0 failed |

## AC2 and AC4: structured sustained-use pass

The use pass spanned successive setup, work, review, inspection, and restart windows during this Worker session. Each ordinary command had an explicit timeout no greater than 180 seconds; temporary service wrappers also had bounded lifetimes. This is repeated bounded local use, not multi-day unattended reliability evidence. No one scenario is designated a mechanical release gate.

### Routine setup and collaboration

The following normalized transcript combines actual authenticated HTTP observations. Response identities are replaced with consistent scenario labels. No authority, receipt, settlement, or usage observation was injected into a store.

```text
Operator session established through /api/auth/session.
Create pending Environment enrollment -> 201.
CLI enroll, one-use claim supplied on stdin -> identity proven, awaiting approval.
Create reusable Builder and Reviewer Agents with ordered Pi work options -> 201 each.
Human approval: agent-run permission + explicit model authorization -> 200.
CLI worker start --foreground -> accepted same-identity connection.
Non-inference readiness request -> 201 with committed receipt.
Agent compatibility -> available; execution remains separately gated.
Create Sprout, lightweight-game, and Unity Projects with Agent memberships
  and Worker-validated default workspace assignments -> 201 each.
Create Sprout Working group with Human creator + both Agents -> 201.
```

No runtime JSON was authored for routine Project, membership, Agent, group, proposal, or Task management. The runtime factory was the actual Core composition, not a fixture adapter. HTTP was the main autonomous control surface; browser coverage is identified separately below.

### Sprout development context

A source snapshot from this checkout contained the Task admission router and ADR-0007. An authenticated Human proposal and begin selected the isolated enrolled Environment, and an attributed Builder advance inspected those files.

```text
Proposal with title/goal/constraints/validation criteria -> 201, revision 1.
Human proposal begin -> 201; Task idle, Task lease held.
Human advance to Builder -> 202.
Actual Pi turn -> completed; final text begins SPROUT_NOTE_READY.
Source facts under inspection: Human begin authority, attributed advances,
  and projected replies' non-routing disposition.
Stop/restart inspection preserved the Task identity and original lease.
After restored Worker evidence: held Task remained observable; no replay.
Human discard after the bounded inspection -> 200, discarded.
```

The Agent reported creating an authority note. Its generated note was not retained and opened before Task-context recycling, so this record does **not** count that note as a separately verified durable artifact. The production source snapshot, admitted turn, completion result, and held/restart facts are the evidence. This was an inspection task against this repository's source, not a production-code change or an accepted patch.

### Lightweight-game context

The Human-authorized game Task produced a small deterministic row-victory function and an assertion script. The retained files were opened after the turn. The function checks array identity, exactly three marks, allowed X/O marks, and equality; the script checks X and O victories, mixed marks, and empty marks.

```text
Proposal -> 201; Human begin -> 201; Builder advance -> 202.
Builder turn -> completed, GAME_RULE_VERIFIED.
Retained source: game-rule.mjs + verify.mjs.
Builder tool result: node verify.mjs exits 0.
Human discard -> 200; Project workspace/game files preserved.
Project-channel @Reviewer Message -> 202, deterministic wake admitted.
Reviewer turn -> completed, GAME_REVIEW_OK; independently ran verify.mjs.
GET Message routing -> agent-mention -> admitted WakeRequest -> same run.
Repeat same delivery key -> duplicate=true, admittedRunIds=[];
  same Message/wake preserved, no second Agent run.
Projected Reviewer reply appeared in the real browser conversation.
```

The Builder used the filename `game-rule.mjs` rather than the requested `game.mjs`; the review named and opened the actual artifact. This does not establish a playable rendered game or broad game correctness. [Earlier Minesweeper evidence](o7-minesweeper-collaboration.md) supplies historical multi-Agent/playable-browser evidence, with its timestamp limitations preserved; it is not counted as a fresh #112 game run.

### Unity development context

Unity CLI reported no connected Pipeline Editor, and Pipeline listing reported no running instances, reachable servers, or Safe Mode instances. That was not treated as proof that Unity was unavailable: an installed Editor was used in an isolated batch journey.

```text
unity status --json -> STATUS_NO_INSTANCES.
unity pipeline list --json -> zero instances / reachable servers / Safe Mode instances.
unity projects create <temporary-project> --editor-version 2022.3.60f1
  -> success=true; opened=false.
unity run <temporary-project> --timeout 60 -> success=true.
Copy only Assets, Packages, and ProjectSettings into the Unity Project workspace.
Human proposal begin -> 201; Builder advance -> 202.
Actual Pi turn -> completed, UNITY_SOURCE_READY.
Opened generated Assets/DogfoodMovement.cs:
  Step returns position + normalized direction * nonnegative speed * nonnegative dt.
Human discard -> 200; persistent Project source preserved.
unity run <Worker-project-workspace> --timeout 60 -> success=true;
  Editor log records script compilation; no C# compiler-error markers.
```

This establishes real product-mediated Unity source work and real Editor import/compilation. **Live scene manipulation and Play-mode validation are environment-limited**: no running Editor with the Pipeline package was found; the exercised installed Editor is 2022.3, while the live Pipeline skill requires Unity 6.0+. No scene, prefab, or asset YAML was hand-edited, and no live Editor or gameplay coverage is fabricated.

### Environment interruption, reconciliation, and explicit recovery

The final authoritative replay used a **fresh second database and Worker identity with explicit enrollment mode**, avoiding the mixed-mode setup error disclosed under attempts. It began a Human-led Sprout Task, advanced an actual Pi turn, inspected it while running with 29 retained events, then stopped the actual isolated foreground Worker through its own host-local CLI state.

```text
Before stop:
  run=running, events=29; Task=in-progress/running; original Task lease held.
CLI Worker stop -> actual isolated Worker signalled.
After stop:
  run=interrupted, events=29; Task lifecycle=recovery; same lease retained.
Restart same enrolled Worker -> accepted reconnect; no automatic new run.
Durable recovery evidence after reconnect:
  retainedEventCount=29; terminalStatus=interrupted;
  turnSettlementObserved=true; engineSessionStopped=true;
  taskContextPrepared=true; taskContextRecycled=false.
Human Task recovery {action:resume, reason:<operator-reason>} -> 200.
  Task=blocked; same lease retained.
Independent read-only SQLite inspection after Core close:
  Environment recovery phase=resolved;
  decisions include reconnect-observed -> evidence-synchronized -> resumed.
Human discard -> 200, discarded.
Fresh recovery-instance Usage -> one interrupted activity;
  complete=0 / partial=0 / unavailable=1; tokens=unavailable.
```

No Force Release was used. [#111's existing evidence](ticket-111-local-operator-validation.md) supplies the unresolved-proof refusal and permanent Force Release chain; this record does not claim it replayed that exceptional journey.

### Real browser phone and desktop operation

An isolated headless Chromium-family browser used a separate profile and the built production Web. The browser-use skill established the initial connection and sign-in; direct CDP used the same isolated browser for the bounded continuation. Buttons/links were resolved through the accessibility tree and clicked through browser mouse input. Composer text entered through its input event and the visible Send action.

```text
390px phone viewport:
  Operator sign-in -> authenticated production Feed.
  Feed document width=390, scroll width=390.
  Visible facts: two still-proposed inspection attempts; four completed activities.
  Manage -> Usage: document width=390, scroll width=390.
  Work-model finalized activities=4; tokens=346,853;
    complete=4 / partial=0 / unavailable=0 at that pre-interruption snapshot.
  API-equivalent estimate=$0.0000, harness-calculated;
    attributable billed cost=unavailable, billing basis=unknown.
  Routing subtotal=0 activities; tokens/duration/estimate unavailable.
  Settings -> authenticated Operator, one current session,
    host-local rotation/recovery responsibilities, supported protocol majors.
  Project Chat -> open #general -> type checkpoint -> visible Send action.
  Live region: "Message sent to #general."
Independent read-only SQLite inspection:
  exactly one durable checkpoint body:
    "Mobile dogfood checkpoint: reviewed game result."
1440px desktop viewport:
  same game conversation and actual Reviewer reply visible;
  document width=1440, scroll width=1440; desktop navigation rendered.
```

This is browser-level operation, not a synthetic DOM viewport claim. It covers one phone write and the stated management/inspection paths. It does not replace the full page state matrices or owner touch-device review. The just-sent checkpoint was confirmed in SQLite; its immediate timeline refresh was not asserted as a separate browser success.

### Truthful Usage observations and limits

At the final inspection of the first isolated store there were **five work activities: four completed and one interrupted**. The known completed-token subtotal remained **346,853** with `observed_incomplete` status and coverage **4 complete / 0 partial / 1 unavailable**. The corrected fresh recovery replay separately showed one interrupted activity with unavailable tokens. These are two independent stores, not an aggregate of six activities.

The first store's four completed activities were Sprout Builder (161,532), game Builder (99,698), game Reviewer (23,610), and Unity Builder (62,013). These totals were read from actual run results and the production Usage view; they sum to 346,853. Detailed cache/input/output dimensions remain separate and are not reconstructed from the simpler prompt/completion fields. The interrupted run had no final token observation, and its missing consumption was not added as zero. Project-owned routing remained a separate empty subtotal because this pass used deterministic addressing; no live wake-model inference or routing-model cost is claimed.

Billed cost was explicitly unavailable. Harness-calculated API-equivalent estimates were zero, with unknown billing basis; that is not a free-service or invoice claim. The phone backing table also exposed metadata limitations recorded as F3/F4 below rather than silently treating its missing chronology as verified.

## AC3: material finding dispositions

These dispositions are the Worker's bounded proposals, to be reconciled by review and the owner. No product-code fix is claimed on #112, and no existing owner risk decision is manufactured by this Worker. New finding numbers begin at F2 as requested.

| Finding | Evidence and impact | Explicit disposition and rationale |
| --- | --- | --- |
| F2: harness zero estimate with unknown billing basis | Four actual Pi turns reported harness-calculated zero API-equivalent cost; Usage labels it as an estimate and reports billed cost unavailable. It cannot establish subscription inclusion or actual payment. | **Accept as a known limit for this evidence.** Local harness valuation is an estimate, not billing authority. Preserve the labels and unavailable billed-cost coverage; revisit if the harness supplies trustworthy nonzero pricing or invoice attribution. No monetary-readiness claim is made from zero. |
| F3: Usage detail chronology and prose are incomplete | Phone backing-table activity times, observation timestamps/supersession references, and displayed cost-source versions show Unavailable in places; coverage prose contains a redaction marker replacing part of a generic token sentence. Numeric dimensions, aggregate coverage, attribution, and billed/estimated distinction remain inspectable. | **Explicitly defer a bounded display/serialization audit outside M2.** It is not loss of the durable observations or an authority/recovery failure, but reduces the Web audit detail. Until corrected, use labeled aggregates and authoritative activity detail rather than claiming exact observation chronology from this table. Revisit before using the Web table as an observation-audit export; proposed owner/reviewer follow-up on #107/#105, no ticket silently added. |
| F4: Pi telemetry version is a pinned parser baseline | The actual Worker probe reported Pi 1.0.0; completed run metadata says `pi 0.85.1` and price-source baseline 0.85.1. [Parser result construction](../../src/engine/pi-protocol.ts) hard-codes the telemetry source version. | **Explicitly defer runtime-version provenance correction outside M2, with a release-relevant limitation disclosed.** Measured token observations are retained, but this string cannot prove the executable version. Use the committed readiness receipt for actual version evidence. A bounded future fix should distinguish measured protocol/catalog baseline from runtime binary version and receive code review; the owner must decide whether this limitation is acceptable for AC5. |
| F5: context breadth is bounded | Sprout used an isolated source-inspection Task, the game is a rule module, Unity used source plus batch compile, and phone coverage is a subset of the full operator state matrix. There was no connected live Pipeline Editor. | **Accept as a known limit of this pass.** These are three independently executable contexts, not one synthetic scenario. Do not claim sustained multi-day use, accepted Sprout patch, playable game, live scene/Play mode, or exhaustive phone parity. Broaden routine owner dogfood without imposing any single prescribed scenario as a release gate. |
| F6: opaque free-text routing secrecy has an owner-accepted exception | [#179 owner decision](https://github.com/tinysnake/sprout/issues/179#issuecomment-5945414141) explicitly permits unlabelled opaque/high-entropy free text to reach the wake model and supersedes the original complete-sanitization outcome. The written ADR/privacy contract is not a proof that these values are removed. | **Accept only as the existing owner-recorded known limit.** #178's research is not an implemented sanitizer. This pass supplied no secrets and did not configure a real wake-model inference adapter. Keep the exception visible for AC5; reopen through the standing channel if the owner's posture changes. |

No new security/privacy/authority or unrecoverable-work defect was established by the final enrolled-Worker pass. That does not erase the metadata limitations or imply owner acceptance.

## Attempts, deviations, and verification

- The first Core/build attempt lacked the locked dependencies: Core could not import `ws`, and the build could not find Vite. `npm ci` restored dependencies without tracked changes. Subsequent `npm run typecheck` and `npm run web:build` passed; build retained its existing large-chunk advisory.
- No production source or test was changed. Full source/Web splits and focused project suites were therefore not rerun. **1640/1640 source and 415/415 Web are inherited #111 post-merge counters at the exact base**, not this Worker's counters. The #111 merge record in the ledger is their source.
- `src/worker/cli/worker-cli-recovery.test.ts` is unchanged from `de1f6f9e`; `src/runtime-reconnect-retry-crash.test.ts` is unchanged from `b9e77a6a` (both diffs empty). #167/reconnect attribution remains UNDETERMINED per a43; the fresh live pass does not reclassify an old test failure.
- Early direct requests omitted required validation criteria or delivery keys, and one harness expected 201 for a successful 202 Message. Corrected requests succeeded; the successful Message's duplicate retry did not create another run. These were driver errors, not product fixes.
- Early bounded Core expiry and Worker backoff caused offline probe/begin refusals; duplicate Worker start was correctly refused while the prior isolated process still owned the state. Subsequent own-state stop/start and fresh probes restored accepted connection.
- The first store's initial lifecycle setup omitted explicit enrollment mode and kept the legacy `configured` default. A later read-only check found its Task resume/discard result did not resolve the Environment ledger through the production enrollment recovery path. That attempt is **invalid as proof of ledger resolution**. The fresh second store explicitly selected enrollment mode and established the complete durable resolved/resumed chain above. No database mutation was used to repair or fabricate either result.
- Initial Unity invocations used a not-yet-created project and then forwarded a reserved `-quit` flag. CLI refused both. Creating the temporary project and allowing `unity run` to manage reserved flags produced the successful Editor runs cited above.
- The first isolated-browser launch used an absent Chrome binary; local harness attachment also encountered proxy/connection setup. An installed Chromium-family browser with isolated profile and direct loopback proxy bypass worked. Early browser continuations raced Core startup or used an incorrect route; they were discarded, and the final browser driver waited for Core readiness and navigated the actual production Chat route before counting any operation.
- Temporary Core/Worker/browser lifetimes were bounded, and only owned isolated processes/state were stopped. Raw logs, sessions, credentials, host paths, and machine facts stayed in temporary storage outside Git. This committed record uses normalized transcripts; port allocations and connection material are omitted.
- No reference design was implemented or copied. `docs/references.md` was consulted; this ticket composes production evidence and runs the existing product.

## Review and Human follow-ups

1. Review this evidence map and finding dispositions against original AC1–AC4; do not infer that a map closes the referenced owner gates.
2. **AC5: the product owner must explicitly accept or reject readiness for routine local development coordination. This remains pending.** F2–F6 and the preceding ticket owner gates must be visible to that decision.
3. Owner acceptance remains pending for #98, #102, #103, #104, #107, #110, #111, and #180. #111 additionally retains the Windows Core-shutdown re-observation with Worker left running.
4. If accepted for continued use, revisit F3/F4 as bounded provenance/detail work and extend normal owner dogfood to longer Sprout changes, richer game work, and a connected Unity Editor. These are proposals, not silently added M2 requirements or a single mechanical release test.

**Disposition:** AC1–AC4 evidence and all material finding dispositions are committed for review. Overall Local Operator MVP acceptance is not declared; AC5 and the explicitly listed Human gates remain pending.
