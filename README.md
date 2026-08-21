# Seminar series site

Static site for a weekly seminar series, hosted on GitHub Pages. The schedule lives in a Google Sheet; a Google Apps Script web app serves it, records sign-ups and sends reminder emails.

- `index.html` — calendar
- `schedule.html` — full season
- `archive.html` — past talks
- `subscribe.html` — calendar feed
- `dashboard.html` — organizer view
- `apps-script/Code.gs` — backend, deployed from the sheet

## Setup

1. Create a Google Sheet, open **Extensions → Apps Script**, paste `apps-script/Code.gs`, save.
2. Reload the sheet and run **Seminar → Set up this sheet**.
3. Fill in the **Settings** and **Labs** tabs, then run **Seminar → Generate Friday dates** and assign a lab to each Friday on the **Schedule** tab.
4. In Apps Script, **Deploy → New deployment → Web app**, execute as yourself, access "Anyone". Copy the `/exec` URL.
5. Paste that URL into `apiUrl` in `assets/config.js`.
6. Run **Seminar → Turn on automatic reminders**.
7. Enable GitHub Pages for this repository (Settings → Pages → deploy from branch, root).

No secrets belong in this repository. Lab access codes and the organizer code live only in the sheet.
