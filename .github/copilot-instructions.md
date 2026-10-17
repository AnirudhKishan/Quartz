# Quartz repository context

Read [README.md](../README.md) before making changes. It documents the product,
architecture, data model, offline behavior, and development commands.

- Quartz is a local-first browser app for measuring adherence to a timetable. It
  is not a task manager, coach, or synchronization service.
- Keep changes simple and scoped. Preserve the existing domain, application,
  infrastructure, and UI boundaries.
- Treat published timetable definitions and user event history as durable data.
  Never silently rewrite them or commit personal backup files.
- Preserve mobile usability and explicit, user-controlled app updates.
