"""Vectorised unit quaternions (w, x, y, z) in numpy: conversions, product, slerp, the shortest arc between vectors."""
import numpy as np


def from_matrix(M):
    M = np.asarray(M, float); shp = M.shape[:-2]; M = M.reshape(-1, 3, 3)
    q = np.empty((len(M), 4))
    t = M[:, 0, 0] + M[:, 1, 1] + M[:, 2, 2]
    for k in range(len(M)):
        m = M[k]
        if t[k] > 0:
            s = np.sqrt(t[k] + 1.0) * 2; q[k] = [0.25 * s, (m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s]
        elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
            s = np.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2; q[k] = [(m[2, 1] - m[1, 2]) / s, 0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s]
        elif m[1, 1] > m[2, 2]:
            s = np.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2; q[k] = [(m[0, 2] - m[2, 0]) / s, (m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s]
        else:
            s = np.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2; q[k] = [(m[1, 0] - m[0, 1]) / s, (m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s]
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    q[q[:, 0] < 0] *= -1
    return q.reshape(shp + (4,))


def to_matrix(q):
    q = np.asarray(q, float); shp = q.shape[:-1]; q = q.reshape(-1, 4)
    q = q / np.linalg.norm(q, axis=1, keepdims=True)
    w, x, y, z = q.T
    M = np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
                  2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
                  2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)], -1).reshape(-1, 3, 3)
    return M.reshape(shp + (3, 3))


def mul(a, b):
    a, b = np.broadcast_arrays(np.asarray(a, float), np.asarray(b, float))
    w1, x1, y1, z1 = np.moveaxis(a, -1, 0); w2, x2, y2, z2 = np.moveaxis(b, -1, 0)
    return np.stack([w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2, w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
                     w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2, w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2], -1)


def inv(q):
    q = np.asarray(q, float).copy(); q[..., 1:] *= -1
    return q


def slerp(a, b, t):
    """Shortest-path slerp; t broadcasts against the quaternion batch (shape (..., 1))."""
    a = np.asarray(a, float); b = np.asarray(b, float).copy(); t = np.asarray(t, float)
    d = np.sum(a * b, -1, keepdims=True)
    b = np.where(d < 0, -b, b); d = np.abs(d)
    th = np.arccos(np.clip(d, -1, 1)); s = np.sin(th)
    small = s < 1e-6
    wa = np.where(small, 1 - t, np.sin((1 - t) * th) / np.where(small, 1, s))
    wb = np.where(small, t, np.sin(t * th) / np.where(small, 1, s))
    q = wa * a + wb * b
    return q / np.linalg.norm(q, axis=-1, keepdims=True)


def arc(u, v):
    """Rotation matrix taking direction u to direction v by the shortest arc."""
    u = np.asarray(u, float) / np.linalg.norm(u); v = np.asarray(v, float) / np.linalg.norm(v)
    c = float(np.dot(u, v)); ax = np.cross(u, v); s = np.linalg.norm(ax)
    if s < 1e-9:
        if c > 0: return np.eye(3)
        p = np.cross(u, [1, 0, 0]) if abs(u[0]) < 0.9 else np.cross(u, [0, 1, 0]); p /= np.linalg.norm(p)
        return 2 * np.outer(p, p) - np.eye(3)
    k = ax / s; K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + s * K + (1 - c) * K @ K


def axis_angle(axis, rad):
    axis = np.asarray(axis, float) / np.linalg.norm(axis)
    K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + np.sin(rad) * K + (1 - np.cos(rad)) * K @ K


def yaw_of(R, forward=(0.0, -1.0, 0.0)):
    """Heading (radians about +Z) of the horizontal projection of R @ forward, measured from forward."""
    f = np.einsum('...ij,j->...i', R, np.asarray(forward, float))
    f0 = np.asarray(forward, float)
    return np.arctan2(f[..., 1], f[..., 0]) - np.arctan2(f0[1], f0[0])
