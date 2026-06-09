# EPStudy Sync Extension

This Chrome/Edge extension syncs signed-in school tabs with EPStudy. It has no popup and only runs on the school services and the EPStudy website listed in the manifest.

## Install

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Click Load unpacked.
4. Select this `extension` folder.
5. Open EPStudy at `https://sillywaffle-4.github.io/Epstudy/` or `https://sillywaffle-4.github.io/EPStudy-V6/`. The Web Store package does not request file or local-development page access.

## Use

Keep EPStudy open, then open signed-in tabs for:

- Canvas, defaulting to `eastsideprep.instructure.com`
- TeamSnap schedule pages on `go.teamsnap.com` for each team you want tracked
- Membean

The extension syncs automatically every 10 minutes. You can also use Settings -> Extension Sync in EPStudy to request a sync, check source health, send website tasks into extension storage, or open Canvas, TeamSnap, and Membean from EPStudy. In V6, the site defaults to Normal mode and reports whether Normal or Simple is active so extension health and exported website tasks follow the selected mode.

## What It Sends

- Canvas assignments and dated todo items found on signed-in Canvas pages
- TeamSnap games, practices, matches, tournaments, and events across multiple team tabs
- Membean weekly progress as session counts only; Canvas teacher-created Membean assignments stay responsible for the actual task
- Extension health metadata, including source status, saved TeamSnap schedule links, Focus Shield state, selected website version, and website task export counts

## Review Notes

- The packaged manifest avoids `<all_urls>`, file URL access, and local-development host access.
- Requested permissions are used for scheduled syncing, local storage, notifications, focus blocking, and injecting EPStudy's own scraper/bridge scripts on the allowed sites.
