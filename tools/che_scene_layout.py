"""CHE Scene Director layout edits, applied to a scene spec before Blender draws it (no bpy here, so it is testable).

Touch edits from the app's live scene preview ("move her left", "make her bigger") land in the spec as
actors[].offset [dx, dy] in metres and actors[].scale. This turns them into what tools/che_scene_render.py already
draws: the actor's walk targets and the seats she uses move by her offset (her chair moves with her), and her height
is ACTOR_HEIGHT times her scale. Her starting spot (the doorway) never moves, so she still walks in through the door.
"""
import copy

ACTOR_HEIGHT = 1.62
MAX_OFFSET = 1.5
SCALE_RANGE = (0.6, 1.6)


def _clamp(x, lo, hi):
    return max(lo, min(hi, x))


def apply_layout(spec):
    out = copy.deepcopy(spec)
    seats = out.get("seats", {})
    for actor in out.get("actors", []):
        dx, dy = [_clamp(float(v), -MAX_OFFSET, MAX_OFFSET) for v in (list(actor.get("offset") or [0, 0]) + [0, 0])[:2]]
        scale = _clamp(float(actor.get("scale") or 1), *SCALE_RANGE)
        if "height" not in actor:
            actor["height"] = round(ACTOR_HEIGHT * scale, 4)
        if not (dx or dy):
            continue
        moved_seats = set()
        for step in out.get("timeline", []):
            if step.get("actor") != actor["id"]:
                continue
            if step.get("action") == "walk" and step.get("to"):
                step["to"] = [round(step["to"][0] + dx, 4), round(step["to"][1] + dy, 4), *step["to"][2:]]
            if step.get("action") == "sit" and step.get("seat") in seats and step["seat"] not in moved_seats:
                s = seats[step["seat"]]
                seats[step["seat"]] = [round(s[0] + dx, 4), round(s[1] + dy, 4), *s[2:]]
                moved_seats.add(step["seat"])
    return out
