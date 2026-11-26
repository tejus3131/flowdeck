// Page renderers — pure functions returning HTML strings. They read
// window.PG_DATA and the philosophy vars via data-attributes in CSS;
// no state, no framework.
(function () {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const chip = (t) => `<span class="fd-chip" data-style="${chipStyle()}" style="--chip: var(--fd-tag-${t.hue})">${esc(t.name)}</span>`;
  const avatars = (list) =>
    `<span class="fd-avatar-stack">${list
      .map((a, i) => `<span class="fd-avatar" style="background: var(--fd-tag-${((i * 3) % 8) + 1})">${esc(a)}</span>`)
      .join('')}</span>`;

  function chipStyle() {
    const p = document.documentElement.dataset.philosophy;
    return { p1: 'soft', p2: 'solid', p3: 'vivid', p4: 'outline' }[p] || 'soft';
  }

  window.PG_PAGES = {
    board(d) {
      return `<div class="board">${d.columns
        .map(
          (col) => `<div class="board-col">
            <div class="board-col-head">${esc(col.name)} <span class="board-col-count">${col.cards.length}</span></div>
            <div class="board-cards">${col.cards
              .map(
                (c) => `<div class="fd-card${c.done ? ' fd-done-pulse' : ''}">
                  <div class="board-card-title">${esc(c.title)}</div>
                  <div class="board-card-meta">${c.tags.map(chip).join('')}</div>
                  <div class="board-card-foot">
                    ${avatars(c.assignees)}
                    ${c.unseen ? `<span class="fd-badge-unseen">${c.unseen} new</span>` : ''}
                  </div>
                </div>`,
              )
              .join('')}</div>
          </div>`,
        )
        .join('')}</div>`;
    },

    drawer(d) {
      return `<div class="drawer-demo">
        <div class="drawer-board-ghost">${window.PG_PAGES.board(window.PG_DATA.board)}</div>
        <div class="drawer">
          <h2>${esc(d.title)}</h2>
          <div class="drawer-props">
            <span class="fd-chip" data-style="${chipStyle()}" style="--chip: var(--fd-accent)">${esc(d.list)}</span>
            <span class="fd-chip" data-style="${chipStyle()}" style="--chip: var(--fd-danger)">${esc(d.priority)}</span>
            ${d.tags.map(chip).join('')}
          </div>
          <div class="drawer-section-label">Assignees</div>
          <div style="margin-bottom: var(--fd-space-4)">${avatars(d.assignees)}</div>
          <div class="drawer-section-label">Description</div>
          <p class="drawer-desc">${esc(d.description)}</p>
          <div class="drawer-section-label">Comments</div>
          ${d.comments
            .map(
              (c) => `<div class="drawer-comment">
                <span class="fd-avatar" style="background: var(--fd-tag-4)">${esc(c.who)}</span>
                <div class="drawer-comment-body">
                  <div class="drawer-comment-meta">${esc(c.who)} \u00b7 ${esc(c.at)}</div>
                  ${esc(c.text)}
                </div>
              </div>`,
            )
            .join('')}
          <div class="drawer-section-label" style="margin-top: var(--fd-space-4)">Activity</div>
          ${d.activity.map((a) => `<div class="drawer-activity">${esc(a)}</div>`).join('')}
        </div>
      </div>`;
    },

    dashboard(d) {
      return `<div>
        <div class="dash-grid">${d.boards
          .map(
            (b) => `<div class="fd-card dash-card">
              <h3>${esc(b.name)}</h3>
              <div class="dash-card-row"><span>${b.cards} cards</span><span>${b.members} members</span></div>
              <div class="dash-card-row"><span>updated ${esc(b.updated)}</span></div>
            </div>`,
          )
          .join('')}</div>
        <div class="dash-updates">
          <div class="drawer-section-label">Updates</div>
          ${d.updates
            .map(
              (u) => `<div class="dash-update">
                <span class="fd-avatar" style="background: var(--fd-tag-6)">${esc(u.who)}</span>
                <div><strong>${esc(u.who)}</strong> ${esc(u.text)} <span style="color: var(--fd-text-3)">\u00b7 ${esc(u.at)}</span></div>
              </div>`,
            )
            .join('')}
        </div>
      </div>`;
    },

    chat(d) {
      return `<div class="chat-panel">
        <div class="drawer-section-label"># ${esc(d.board)}</div>
        ${d.messages
          .map(
            (m) => `<div class="chat-msg">
              <span class="fd-avatar" style="background: var(--fd-tag-3)">${esc(m.who)}</span>
              <div class="chat-msg-body">
                <div class="chat-msg-meta"><strong>${esc(m.who)}</strong> \u00b7 ${esc(m.at)}</div>
                ${esc(m.text)}
              </div>
            </div>`,
          )
          .join('')}
        <div class="chat-composer">
          <input class="fd-input" placeholder="Message the board\u2026 (@ to mention)" />
          <button class="fd-btn" data-variant="primary">Send</button>
        </div>
      </div>`;
    },

    profile(d) {
      return `<div class="profile">
        <div class="profile-head">
          <span class="fd-avatar profile-avatar" style="background: var(--fd-accent)">${esc(d.name[0])}</span>
          <div>
            <h2 style="margin:0">${esc(d.name)}</h2>
            <div style="color: var(--fd-text-3)">${esc(d.email)}</div>
            <div style="color: var(--fd-text-2); font-size: var(--fd-text-sm)">${esc(d.status)}</div>
          </div>
        </div>
        <div class="drawer-section-label">MCP connections</div>
        ${d.tokens
          .map(
            (t) => `<div class="profile-row">
              <span>${esc(t.name)}</span>
              <span class="profile-token">fd_\u2022\u2022\u2022\u2022\u2022\u2022 \u00b7 used ${esc(t.used)}</span>
            </div>`,
          )
          .join('')}
      </div>`;
    },
  };
})();
