# CircleFTP provider for Nuvio

A Nuvio provider that searches CircleFTP by movie title, opens the first `/content/<id>` result, and extracts its direct media URL from the Download link (falling back to the HTML5 `<source>` / `<video>` URL).

> **Limitations:** This is a community scraper, not an official CircleFTP integration. It only supports movies. It chooses the first search result and does not verify that the title exactly matches. The site currently uses plain HTTP for its search/content pages; Android/Nuvio network-security rules or the site's own availability may prevent access or playback. Use only content you are authorized to access.

## Repository contents

- `manifest.json` — Nuvio repository manifest
- `providers/circleftp.js` — standalone provider file loaded by Nuvio
- `server.js` — dependency-free local HTTP server for the Nuvio Plugin Tester
- `tests/circleftp.test.js` — mocked tests for scraping and empty-result behavior
- `.github/workflows/test.yml` — runs tests on GitHub pushes and pull requests

## Quick test on your PC

Requires Node.js 18 or newer.

```sh
npm test
npm start
```

The tests use mocked pages and do **not** download or play media. They verify scraper logic only.

## Test in Nuvio directly (development build)

The Plugin Tester is available in the Nuvio development/debug build, not normally in the production build. The Nuvio provider guide documents testing from a local server and loading a provider by URL.

1. Connect your PC and phone/tablet to the same Wi-Fi/LAN.
2. On the PC, run `npm start` in this folder.
3. Find your PC's LAN IPv4 address (Windows: `ipconfig`). Allow Node.js through Windows Firewall on **Private networks** if prompted.
4. In Nuvio's **Settings → Developer → Plugin Tester**:
   - For **Individual Plugin**, load `http://PC-LAN-IP:3000/providers/circleftp.js`.
   - For **Repo Tester**, load `http://PC-LAN-IP:3000/manifest.json`.
5. Use a movie TMDB ID, media type `movie`, and null/empty season and episode. If the runtime permits passing a title string directly, that can also be used to test title search. Otherwise, the provider tries to get the title from TMDB's public page using the ID.
6. Check the tester's Logs and Results. Try Play on a returned stream to test actual playback.

Replace `PC-LAN-IP` with your computer's actual LAN IPv4 address, e.g. `192.168.1.20`. Do not use `localhost` on the phone; it points to the phone itself.

## Install from GitHub

1. Create a new GitHub repository, e.g. `nuvio-circleftp-provider`.
2. Upload the contents of this folder so `manifest.json` is at the repository root (not nested inside another folder).
3. In Nuvio → Settings → Plugins, add this raw manifest URL:

   `https://raw.githubusercontent.com/USERNAME/REPOSITORY/main/manifest.json`

4. Replace `USERNAME/REPOSITORY` with your GitHub owner and repository name, refresh plugins, and enable CircleFTP.

You can use the local Repo Tester URL before publishing. A GitHub-hosted manifest is convenient after the repo is public.

## How it works

1. Gets a movie title passed by the runtime, or attempts to retrieve it from TMDB using the ID.
2. Requests `http://new.circleftp.net/search?q=<encoded title>`.
3. Finds the first `/content/<id>` link.
4. Fetches that content page and extracts the Download link, with video source fallbacks.
5. Returns a Nuvio stream object with URL, quality/title, Referer and User-Agent headers.

## Troubleshooting

- **TMDB title lookup fails:** inspect the Plugin Tester's Logs. If possible, test with a title string as the first argument to isolate the CircleFTP search logic.
- **No results:** check whether CircleFTP is reachable from your network and inspect Logs. The site's HTML may change.
- **Stream returned but does not play:** try opening the direct URL in a browser on the same network. HTTP cleartext restrictions, hotlink protection, server limits, or unsupported codecs can prevent native playback.
- **Phone cannot reach local server:** use the PC's LAN IPv4 address, same Wi-Fi, and permit inbound TCP port 3000 on the Windows Private profile. Do not expose the server to the public internet.

## License

MIT for the provider code in this repository. This does not grant rights to content hosted by CircleFTP or any third party.
