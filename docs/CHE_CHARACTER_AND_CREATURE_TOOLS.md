# CHE character and creature tools: 5 bio tools, 10 more, 5 examples (research, not built)

Owner goal (2026-10-28): a menu in the creation room, like a game's character editor, that builds and edits humans,
animals, insects, creatures, plants and dragons in seconds, and lets the owner customize any part by voice or typing,
with no coding and no login. Same for scenes and rooms.

Status key: **verified** = checked at the source in this session; **search** = from a search summary, not checked at
source; **unverified** = from memory, check before use.

## What "free GPU with no login" can and cannot mean

- **Free, no login, works now:** the owner's own GPU. WebGPU runs in the iPhone's Safari; Safari 26 ships WebGPU on iOS
  and iPadOS 26 (**search**: [WebKit WWDC25 note](https://discuss.privacyguides.net/t/news-from-wwdc25-webkit-in-safari-26-beta/28226), [iOS 26 WebGPU](https://appdevelopermagazine.com/webgpu-in-ios-26/)). three.js has a WebGPU renderer that falls back to WebGL 2 (**search**: [migration guide](https://www.utsubo.com/blog/webgpu-threejs-migration-guide)). Editing and showing pre-built characters is real time on the phone. Nothing is sent to a server, so no login and no cost.
- **Free, but needs an account:** Google Colab, Kaggle and Hugging Face Spaces give a free GPU after login. Mixamo and Sketchfab downloads need an Adobe or Sketchfab login. These are not "no login".
- **Not free, no login:** hosted generators (Meshy, Tripo) charge credits. Left out.
- **Heavy generation** (new creatures from text) needs a server GPU. Free ones need an account, so this runs as a background job on the owner's Colab (Q-35), not inside the voice reply.

So the honest plan: pre-built characters edit instantly on the phone, with no login. New creatures from text come from the owner's Colab in the background.

## The 5 bio tools

| # | Tool | Role | License / terms | Source |
|---|---|---|---|---|
| 1 | **Quaternius packs** (monsters, dragons, farm and wild animals) | Ready animated creatures, incl. dragon and skeleton | CC0 for the OpenGameArt packs (**search**); the Sketchfab listing of the same pack shows a different license and a NoAI tag, so check each file at source | [OpenGameArt monsters](https://opengameart.org/content/lowpoly-animated-monsters), [animal pack](https://opengameart.org/content/lowpoly-animated-farm-animal-pack), [Quaternius licence summary](https://licenseorg.com/guide/3d-assets/quaternius) |
| 2 | **MakeHuman** | Human body, face and proportions, with sliders for size, age, build and skin | Code AGPL; exported characters CC0 only when exported from an official, unmodified build (**search**: [FAQ](https://static.makehumancommunity.org/makehuman/faq/are_makehuman_files_free.html), [license thread](https://lists.opensource.org/pipermail/license-discuss_lists.opensource.org/2017-October/019975.html)) | [MakeHuman](https://en.wikipedia.org/wiki/MakeHuman) |
| 3 | **VRM format with three-vrm** | One humanoid avatar standard that loads in three.js; expressions and bones for real-time posing | Spec MIT (**search**); three-vrm MIT (**search**); each avatar has its own terms | [VRM terms](https://vrm.dev/en/vrm/meta/license/), [three-vrm](https://cdn.jsdelivr.net/npm/three-vrm@0.0.17/README.md) |
| 4 | **Open Source Avatars registry** | Community avatars under open licenses, in VRM | Per collection (**search**: [registry](https://github.com/toxsam/open-source-avatars)) | same |
| 5 | **Poly Haven and Kenney asset libraries** | Plants, props and textures for scenes and rooms | Poly Haven CC0 (**search**). Kenney CC0 (**unverified**) | [Poly Haven](https://polyhaven.com/) |

Insects and plants are the weakest category: the packs above mostly cover animals and monsters. Plants come from Poly
Haven; insects need a pack that is not yet verified.

## The 10 more tools (apps, websites, and tools for the menu, scenes and rooms)

| # | Tool | Role | Status |
|---|---|---|---|
| 6 | **VRoid Studio** | Free desktop character creator with hair, face and body editors; exports VRM | Free to use; license and whether it can run inside CHE **unverified**. Desktop only, so it runs on the owner's computer, not the phone. |
| 7 | **Blender** with the MakeHuman bridge | Rig, pose and export for any character or room | GPL (**unverified** at source); MakeHuman bridge in its repo (**search**) |
| 8 | **Ready-made animation libraries** (Mixamo) | Walk, run and idle animations for rigged humanoids | Free with an Adobe login (**search**); not no-login |
| 9 | **Sketchfab free models** | Large model catalog, filter by CC0 | Needs a Sketchfab login for downloads (**search**); check each license |
| 10 | **Wikipedia and Wikimedia Commons** | Look up what a creature or plant is and what it looks like | Text CC BY-SA; images per file (**unverified**) |
| 11 | **three.js WebGPU renderer** | Real-time rendering on the phone, WebGL fallback | Renderer in use (**search**); check the release notes before pinning a version |
| 12 | **three-vrm** (also in tool 3) | Loads and poses VRM avatars in the app's viewer | MIT (**search**) |
| 13 | **glTF and GLB loaders** | Load every part as a GLB; already used by the app | In repo: `assets/office3d/three.min.js`, `CheNativeSceneWorld` |
| 14 | **Hugging Face Spaces** (free GPU tier) | Hosted text-to-3D for background jobs | Needs a Hugging Face login (**unverified** limits) |
| 15 | **Colab / Kaggle free GPU** | Background renders for heavy generation | Needs a Google or Kaggle login (**unverified** limits); existing Colab T4 worker is in repo (`scripts/che_gpu_worker.py`) |

## The 5 examples (asset categories, not finished characters)

1. **Human, customizable:** MakeHuman sliders plus VRM for pose, with skin tone, hair, build, age and clothing chosen by the owner. Any background, any body. Real-time edits on the phone.
2. **Animal:** a Quaternius wolf- or farm-animal pack, animated, with color and size sliders.
3. **Dragon:** a Quaternius dragon from the monster pack, with flying and attack animations and a color and wing-size control.
4. **Creature (skeleton or slime):** a Quaternius monster, with a scale slider and a color slider.
5. **Plant or room:** a Poly Haven plant or prop, placed in a room with lighting controls.

Each example is a list of asset files plus sliders. None is built, and none is verified on a phone.

## Next steps (in order)

1. Check each Quaternius file's license at its download page, and MakeHuman's export terms, before shipping any asset.
2. Prototype one character (example 1) in the existing creation studio, measure the time to load and edit on the owner's
   iPhone in Safari 26, then decide the rest.
3. Put heavy generation on the owner's Colab as a background job (Q-35), with a receipt.
