import React from 'react';
import { createRoot } from 'react-dom/client';
import './contentScript.css';

const CONTAINER_ID = 'intent-read-first-root';

function mountPanel() {
  if (document.getElementById(CONTAINER_ID)) return;

  const container = document.createElement('div');
  container.id = CONTAINER_ID;
  document.body.appendChild(container);

  const root = createRoot(container);
  root.render(
    <div className="intent-panel">
      <div className="intent-panel__header">Read-First</div>
      <p className="intent-panel__copy">
        This is a placeholder panel. Next up: fetch transcript, summarize, and
        track read progress.
      </p>
      <button className="intent-panel__button" type="button">
        Generate Summary
      </button>
    </div>
  );
}

mountPanel();
