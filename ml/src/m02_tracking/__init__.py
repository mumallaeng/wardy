"""Wardy M-02 anonymous short-term person tracking."""

from .adapter import M02TrackingAdapter
from .tracker import Detection, GeometricMultiObjectTracker, TrackedDetection

__all__ = [
    "Detection",
    "GeometricMultiObjectTracker",
    "M02TrackingAdapter",
    "TrackedDetection",
]
