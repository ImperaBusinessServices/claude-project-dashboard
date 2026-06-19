## v2.3.2 — one app, one tray meter

**Fix: duplicate tray meters.** With the usage meter turned on, closing the dashboard keeps the app running in the tray (by design). But opening it again used to start a *second* copy of the app — piling up a new tray meter every time. The app now enforces a single-instance rule: if a copy is already running, launching again just brings the existing window back to the front instead of starting another. No more stacks of duplicate meters.
