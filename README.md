# Seminar series site

Static site for a weekly seminar series, hosted on GitHub Pages. The schedule lives in a Google Sheet; a Google Apps Script web app serves it, records sign-ups and sends reminder emails.

Each date carries **two presenter slots**. The Schedule tab assigns a lab to each — `Lab 1` and `Lab 2` — and each lab supplies one presenter using its own access code.

- `index.html` — calendar
- `schedule.html` — full season
- `archive.html` — past talks
- `subscribe.html` — calendar feed
- `dashboard.html` — organizer view
- `apps-script/Code.gs` — backend, deployed from the sheet

## Setup

1. Create a Google Sheet, open **Extensions → Apps Script**, paste `apps-script/Code.gs`, save.
2. Reload the sheet and run **Seminar → Set up this sheet**.
3. Fill in the **Settings** and **Labs** tabs, then run **Seminar → Generate Friday dates** and assign two labs to each Friday on the **Schedule** tab — one under `Lab 1`, one under `Lab 2`.
4. In Apps Script, **Deploy → New deployment → Web app**, execute as yourself, access "Anyone". Copy the `/exec` URL.
5. Paste that URL into `apiUrl` in `assets/config.js`.
6. Run **Seminar → Turn on automatic reminders**.
7. Enable GitHub Pages for this repository (Settings → Pages → deploy from branch, root).

No secrets belong in this repository. Lab access codes and the organizer code live only in the sheet.

If the sheet was set up before there were two presenters per date, re-run **Seminar → Set up this sheet**: it renames `Lab` to `Lab 1`, adds `Lab 2` to the Schedule tab and `Slot` to the Signups tab, and marks existing sign-ups as slot 1. Existing data is left where it is.
