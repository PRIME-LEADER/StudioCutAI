# StudioCut AI

A browser-based video editor built with React, TypeScript, Vite, and FFmpeg.wasm. It includes prompt-driven editing, video looks and title overlays, and text-to-video generation.

The responsive app can be installed from supported desktop browsers as a standalone PWA. A Tauri v2 Windows shell and NSIS installer configuration are included; building and signing an installer requires a Windows/Rust toolchain and a configured hosted API.

## Run locally

Use Node.js 22.12 or newer:

```sh
npm install
cp .env.example .env.local
# Add provider keys to .env.local, then:
npm run dev
```

The development command starts both the Vite app and its same-origin API server. Run `npm run build` to type-check and create a production build, then `npm start` to serve the build and API together.
The development API defaults to `127.0.0.1:8788`; if that port is in use, set a different `AI_API_PORT` in `.env.local` and restart the app.

## Free-first AI and provider setup

Copy `.env.example` to `.env.local` and add keys issued to your own accounts. Keys are read only by the backend and are never included in the browser bundle.

- **Gemini** is the primary vision and text provider (`GEMINI_API_KEY`).
- **Groq** is an optional fallback (`GROQ_API_KEY`). Set `AI_PROVIDER=auto` for Gemini then Groq, or `gemini` / `groq` to prefer one. The editor also has a per-session provider selector. Speech captions use Gemini audio understanding or Groq Whisper.
- **Jamendo** search and AI music matching need your own `JAMENDO_CLIENT_ID`. Register through the [Jamendo developer portal](https://devportal.jamendo.com/). Results include previews, track pages, and license links; only tracks that Jamendo marks downloadable are offered for import.
- API requests are rate-limited. Provider quota/rate-limit errors put that provider in a cooldown and can fall back to the other configured provider. There is no automatic paid-tier upgrade or Runway integration. Provider free tiers and model availability can change; the application cannot detect whether a provider account has billing enabled. To guarantee zero charges, use keys on accounts with billing disabled and confirm each provider's current quota and pricing.
- AI Edit, script, summary, scene suggestions, and AI music matching analyze downscaled frames. Speech caption requests extract audio locally, then send compressed MP3/M4A audio to the selected AI provider. The full source video is not uploaded for those AI tasks.

Use the **Test** buttons in the AI panel and Jamendo tab to check credentials and connectivity. Status reports configuration and local model readiness without returning secret values.

### Optional local video generation

Video generation has no hosted/paid provider fallback. To enable it, install [ComfyUI](https://github.com/comfyanonymous/ComfyUI), install a compatible open-source video model and its required nodes, and export a ComfyUI **API-format workflow** as JSON. Set `COMFYUI_BASE_URL`, `COMFYUI_WORKFLOW_FILE`, `COMFYUI_OUTPUT_NODE_ID`, and the prompt/model/width/height/duration node IDs and input names in `.env.local`. The selected model must be present in ComfyUI. Set `COMFYUI_MIN_VRAM_GB` to the workflow model's minimum if known. Without a reachable ComfyUI server, valid workflow, video output node, and available model, generation remains disabled and the editor reports why. Device memory is checked when ComfyUI reports it; CPU-only runs may be too slow or unsupported.

The local adapter sends generated prompts only to your configured private-network ComfyUI instance. The configured workflow controls model weights and required hardware. Model files and GPU requirements are not bundled with StudioCut.

## Editing

- Import multiple browser-supported videos and optional music. Drag video clip edges to trim and clips to reorder, or split, duplicate, and delete them. Export normalizes mixed source dimensions to 720p landscape.
- Describe the edit you want in **AI Edit**. Review the proposed cuts, look, title, and soundtrack level, then apply the plan to the timeline.
- **AI Tools** can write a video summary/script, analyze scenes, and generate timed speech captions as a downloadable SRT file. Caption audio is limited to 8 minutes and the 16 MB compressed-audio cap.
- Choose a color look, adjust brightness/contrast/saturation, add a styled title overlay, and set cut/dissolve/fade/wipe transitions. Preview and export these choices in MP4.
- Keyboard shortcuts: **Space** plays/pauses, **Ctrl/⌘+B** splits the selected clip at the playhead, and **Delete/Backspace** removes it.
- **Jamendo** provides music search by query, genre, and mood. Preview tracks, inspect licensing/attribution, then add a track to the project.
- **Generate Video** uses only the configured local ComfyUI workflow. Preview/import results into the existing project timeline, or ask AI to find Jamendo music matching the prompt and sampled frames.
- Drag music on the timeline, adjust audio, and export the assembled edit.
- Project metadata is stored in local storage and project media/timeline data in IndexedDB in the current browser. Clearing browser storage removes saved projects.

Video format support depends on browser playback and FFmpeg.wasm codec support. AI-generated clips and AI edit analysis require network access and configured provider accounts.

## Cloud projects and account setup

StudioCut keeps its local-first IndexedDB project store. Cloud sync is an opt-in layer; the included Supabase migration adds private per-user project metadata, optimistic revision checks, up to 25 recovery versions, and a private `project-media` bucket. Project metadata sync and media upload have separate controls. Media upload is **off by default** and the app never deletes cloud media objects automatically.

1. Create a Supabase project and configure email/password authentication.
2. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` for the frontend build. Set matching `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in the Node API environment. The publishable key is intended for browser use; Row Level Security protects user data.
3. Apply [`supabase/migrations/202611020001_studiocut_cloud_sync.sql`](./supabase/migrations/202611020001_studiocut_cloud_sync.sql) using the Supabase SQL editor or Supabase CLI. Set the Supabase Auth site's URL and allowed redirect URLs for your web domain and desktop app.
4. For a hosted API, set `REQUIRE_SUPABASE_AUTH=true`. Every `/api/*` request except the health check then requires a valid Supabase access token; the backend verifies it with Supabase Auth. `SUPABASE_SECRET_KEY` is not needed for normal sync and must remain backend-only if configured.
5. Sign in on the dashboard and opt in to project sync. Enable the separate media checkbox only when you want private footage and audio uploaded. TUS resumable uploads use 6 MB chunks and retries. Conflicting revisions fail without replacing the local copy. Restore cloud versions explicitly from History.

When AI tools inspect imported footage, explicitly enable the consent checkbox in the AI panel first. The current AI workflows send sampled frames or compressed speech audio—not the full source video—to the configured cloud AI provider. Disabling consent blocks those requests.

Cloud and API configuration are optional for local editing. `SUPABASE_SECRET_KEY` is never prefixed with `VITE_`, written into the client bundle, or required for user-scoped RLS operations.

## Hosting and Windows setup

### Hosted web application and API

- This repository uses a **single Node web service** for the Vite frontend and `/api/*` backend. [`render.yaml`](./render.yaml) is a Render Blueprint for that service; [`Dockerfile`](./Dockerfile) is an alternative container deployment. The Node process listens on Render's `PORT` and binds to `0.0.0.0`. Keep `VITE_API_BASE_URL` empty for this same-origin setup; do not point it at a guessed or unrelated hostname.
- To provision it, push this repository to a GitHub account you control, then in Render choose **New → Blueprint**, connect the repository, and deploy the Blueprint from `render.yaml`. Render assigns the public service URL after creation; this repository cannot know or preconfigure that generated URL.
- In the Render Blueprint setup/dashboard, configure the Supabase values requested by `render.yaml`: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_URL`, and `SUPABASE_PUBLISHABLE_KEY`. Use the same project URL and publishable key in frontend and backend settings. The Blueprint enables `REQUIRE_SUPABASE_AUTH=true`, so protected API routes return a configuration error until backend Supabase settings are valid. Apply [`supabase/migrations/202611020001_studiocut_cloud_sync.sql`](./supabase/migrations/202611020001_studiocut_cloud_sync.sql) to that project before using cloud sync.
- Set Supabase Auth's site URL and redirect allowlist to the actual Render service URL shown after provisioning. If you later attach a custom domain to this Render service, update those Auth URLs to that domain. Do not point the editor's API at `studiocut.ai` unless that domain is actually routed to this service.
- Set `GEMINI_API_KEY`, `GROQ_API_KEY`, and `JAMENDO_CLIENT_ID` in the Render dashboard only for providers you intend to enable. These are server-only values; never use `VITE_` prefixes for private credentials. StudioCut does not upgrade provider plans or use a paid video-generation provider.
- Render's `healthCheckPath` is `GET /api/health`; it returns JSON and does not require Supabase authentication. After deployment, verify `https://<the-render-service-hostname>/api/health` returns HTTP 200 JSON. Then open the editor on that **same service hostname**: its relative `/api/*` requests automatically reach the backend. No separate web CORS origin is required for same-origin requests. For desktop requests, add the exact desktop origin (normally `http://tauri.localhost`) to `API_ALLOWED_ORIGINS`.
- The existing `studiocut.ai` domain currently serves a separate marketing site; its `/api/health` and `/editor` routes return 404. No editor or backend deployment is currently attached to that domain. This repository change prepares the Render deployment but does not create a Render service, configure DNS, or deploy code; those steps require access to your GitHub, Render, Supabase, and domain accounts.

### Windows desktop

Install Node.js 22+, Rust stable, the Visual Studio C++ Build Tools, and WebView2 on a Windows build machine. Set `VITE_API_BASE_URL` in `.env.local` to the HTTPS URL of the deployed StudioCut API, then add `http://tauri.localhost` to that API's `API_ALLOWED_ORIGINS`. Build the current-user NSIS installer with:

```sh
npm ci
npm run tauri:build:windows
```

The installer is unsigned until you configure code signing. FFmpeg.wasm is copied from the installed npm package into the app build, so local editing/export does not download FFmpeg from a CDN. Cloud AI/music calls use the configured hosted API. The current ComfyUI adapter runs in the Node API process; a packaged local ComfyUI bridge/sidecar is not yet implemented, so a remote API cannot reach a user's `127.0.0.1` ComfyUI. Do not treat local generation as available in the Windows app until that bridge is added and tested.

## Project backup and recovery

- Keep the browser or installed app's local site data intact: local project metadata and media are stored in IndexedDB and clearing app data removes that local copy.
- For cross-device recovery, sign in, enable cloud project sync, and separately enable media upload. The cloud project history retains up to 25 metadata revisions; old media objects are intentionally retained to avoid deleting assets referenced by prior versions.
- Use a cloud project's **History** and **Restore version** controls to recover an earlier revision. A stale local revision is rejected as a conflict rather than silently replacing newer cloud data.
- This initial cloud layer does not provide an account-wide archive download, automatic conflict merging, or automatic remote deletion. Keep independent backups of irreplaceable source media.

## Current integration limits

- Gemini, Groq, Jamendo, Supabase Auth/Storage, and ComfyUI calls require credentials or services you control. No live credentials were present in this work environment, so no live account test or deployment was performed.
- Supabase sync requires the included database migration and configured Auth. The service-role/secret key is not used by the app; user-owned data is accessed through RLS.
- Local-to-cloud sync runs for the active project, on sign-in/opt-in, and when connectivity returns. Cloud-only projects and newer versions on another device are shown for explicit restore rather than silently pulled over local edits.
- The Windows installer has not been built or signed here. This environment has no Rust/Cargo compiler or Windows toolchain.
- ComfyUI readiness checks use its system stats and node metadata; generation uses queue submission/status, history, and output retrieval. Image upload and WebSocket-driven progress are not currently used by StudioCut's prompt-only video workflow.
- Jamendo discovery currently uses `/tracks/`; album, artist, and playlist browsing endpoints are not wired into the UI. Provider usage/quota reporting is limited to provider responses and cooldowns, where available.
