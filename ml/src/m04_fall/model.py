from __future__ import annotations

import torch
from torch import nn


class TemporalFallGRU(nn.Module):
    def __init__(self, input_size: int, hidden_size: int = 64, dropout: float = 0.25):
        super().__init__()
        self.input_projection = nn.Sequential(
            nn.Linear(input_size, hidden_size),
            nn.LayerNorm(hidden_size),
            nn.ReLU(),
        )
        self.gru = nn.GRU(hidden_size, hidden_size, batch_first=True)
        self.classifier = nn.Sequential(
            nn.Dropout(dropout),
            nn.Linear(hidden_size, hidden_size // 2),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_size // 2, 1),
        )

    def forward(self, features: torch.Tensor) -> torch.Tensor:
        projected = self.input_projection(features)
        _, hidden = self.gru(projected)
        return self.classifier(hidden[-1]).squeeze(-1)
