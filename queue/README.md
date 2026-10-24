Render requests for the Colab worker (scripts/che_gpu_worker.py). One JSON file per request:
{"id", "views", "settings" (overrides the face defaults), "samples", "res", "note"}. Each id renders once;
the outcome is kept in the owner's Drive (CHE_GPU/worker_done.json). Face only until the owner approves body work.
