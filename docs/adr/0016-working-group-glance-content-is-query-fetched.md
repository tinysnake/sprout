# Working group glance content is query-fetched; wakes carry only a pointer

Agents read Working group state through explicit glance queries instead of wake-time content injection. #260 originally approved handing the owner its assigned Tasks when it is next awakened in that WG; that provision was amended so a wake prompt carries only a one-line pointer (the glance has N entries) while all content arrives through the single explicit-query path. We rejected full injection because it creates a second content-supply path with its own freshness and visibility rules that can drift from the glance, and we rejected a pure query with no wake hint because Agents perform no periodic discovery — a task could sit on the glance forever without anyone ever looking.

## Considered Options

- **Injection at wake (rejected):** guarantees delivery, but splits content across two paths and reimports the wake-prompt coupling the glance exists to replace.
- **Pure query, no hint (rejected):** one clean path, but loses #260's anti-starvation intent; nothing ever tells the owner there is something to read.
- **Pointer at wake + explicit query (chosen):** discovery is prompted, content has exactly one path, and glance changes still never wake anyone.
