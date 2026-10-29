# CHE free 3D build tools: 10 candidates (research, not built)

Owner goal (2026-10-28): CHE looks up a thing she doesn't know (for example, a car), learns its parts, and renders every
part as a 3D model from a spoken or typed request, as fast as possible, for free.

Status key: **verified** = license checked in the project's own repo or docs in this session; **search** = taken from
a search summary, not yet checked at the source; **unverified** = from memory, to check before use.

## The pipeline these tools fill

1. **Look up** the subject and its parts (free public knowledge sources).
2. **Plan** a parts list with real dimensions, and mark which parts are simple shapes and which are organic.
3. **Model simple parts** with parametric CAD (fast, CPU, exact dimensions).
4. **Generate organic parts** from text or an image with a 3D generator (GPU, slower, approximate).
5. **Show** every part in the app's existing 3D viewer, one GLB per part, and let the owner edit by voice.

Real time is possible for step 3 and for showing finished parts. Step 4 is seconds to minutes on a GPU and is not
real time on a phone. It runs as a background job with a receipt (Q-35), not in the voice turn.

## The 10 tools

| # | Tool | Role | License | Runs where | Source |
|---|---|---|---|---|---|
| 1 | **CadQuery** | Parametric CAD in Python: exact parts from dimensions | Apache 2.0 (**search**: project README) | CPU, server or owner's machine | [pypi](https://pypi.org/project/cadquery/0.5.1), [CadQuery alternatives list](https://alternativeto.net/software/cadquery/) |
| 2 | **OpenSCAD** | Script-based CAD for simple parts and assemblies | GPL-2.0 (**unverified**) | CPU | [AlternativeTo](https://www.alternativeto.net/software/openscad/) |
| 3 | **FreeCAD** | Parametric CAD with a Python API, for detailed mechanical parts | LGPL-2.1 (**unverified**) | CPU | [AlternativeTo](https://www.alternativeto.net/software/openscad/) |
| 4 | **TRELLIS** (Microsoft) | Image and text to 3D for organic shapes; GLB output with PBR materials | MIT (**search**: [TRELLIS.2 overview](https://www.3daistudio.com/blog/is-trellis-2-free-pricing-how-to-get-started)) | Owner's GPU (Colab T4) | [comparison](https://trellis2.app/blog/trellis-2-vs-hunyuan-3d) |
| 5 | **TripoSR** (Stability AI) | Fast image to 3D; needs about 6 to 8 GB VRAM | MIT (**search**: [Open Source AI 3D overview](https://www.cmarix.com/blog/top-open-source-ai-models-for-3d-image-generation/)) | Owner's GPU | same |
| 6 | **Hi3DGen** (Stable-X) | Image to 3D, built on a TRELLIS backbone | MIT (**search**: [comparison](https://trellis2.app/blog/best-image-to-3d-models-huggingface)) | Owner's GPU | same |
| 7 | **Blender** plus an MCP server | Full scene building, rendering and export; CHE already runs Blender in the face renders | GPL (**unverified**); MCP servers vary | Owner's GPU or CPU | [projects.blender.org MCP repo](https://projects.blender.org/lab/blender_mcp/raw/branch/main/readme.md), [MCP overview](https://glama.ai/mcp/servers/hfylp8dt83) |
| 8 | **Poly Haven** | Reference models and textures to compare parts against | CC0 (**search**: [license page](https://polyhaven.com/ja/license)); no-key API per third-party guides (**unverified** at source) | Download, any machine | [Poly Haven](https://polyhaven.com/) |
| 9 | **Wikipedia and Wikimedia Commons** | Look up what a car is and its parts, with images; cite the page | Text CC BY-SA; image licenses differ per file (check each one) | Free public API | [Wikipedia](https://www.wikipedia.org/) |
| 10 | **Three.js with GLTFLoader** | Shows every GLB part in the app viewer | MIT | Phone (already bundled in `assets/office3d/`) | repo: `assets/office3d/three.min.js` |

## Not chosen

- **Hunyuan3D (Tencent):** the open releases use a Community License that excludes the EU, UK and South Korea, and
  the newest versions are hosted-only (**search**: [comparison](https://trellis2.app/blog/trellis-2-vs-hunyuan-3d)).
  Left out until its terms are checked for the owner's use.

## Cost and honesty

- Everything above is free to use. Hosted generators (for example Tripo or Meshy) charge credits; they are not in
  this list.
- No tool here has been installed or run in this session. Each becomes "built" only after a test renders a real
  part and the result is checked on the phone.
- Owner's GPU (Colab T4) is the only GPU route here that costs nothing. Paid routes stay under Q-35 items 15 to 19.

## Next step

1. Build the parts pipeline with tools 1, 9 and 10: look up a subject, list its parts, make the simple ones with
   CadQuery, and show them in the viewer. Test it with a car and a bicycle.
2. Add tools 4 to 6 on the owner's Colab as background jobs, after the license of each is checked at its source.
3. Verify licenses for tools 2, 3, 7 and 8 at their repos before any of them ships.
