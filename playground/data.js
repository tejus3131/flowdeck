// Sample data — realistic Flowdeck shapes so the pages feel true.
window.PG_DATA = {
  board: {
    title: 'Design system rollout',
    columns: [
      {
        name: 'Backlog',
        cards: [
          {
            title: 'Audit current token usage',
            tags: [
              { name: 'design', hue: 6 },
              { name: 'debt', hue: 1 },
            ],
            assignees: ['TJ', 'KP'],
            unseen: 3,
          },
          {
            title: 'Draft motion budget rules',
            tags: [{ name: 'motion', hue: 4 }],
            assignees: ['TJ'],
            unseen: 0,
          },
        ],
      },
      {
        name: 'In progress',
        cards: [
          {
            title: 'OKLCH palette generator',
            tags: [
              { name: 'design', hue: 6 },
              { name: 'infra', hue: 5 },
            ],
            assignees: ['TJ', 'AK', 'RS'],
            unseen: 1,
          },
          {
            title: 'Card drawer IA rework',
            tags: [{ name: 'ux', hue: 7 }],
            assignees: ['KP'],
            unseen: 0,
          },
        ],
      },
      {
        name: 'Done',
        cards: [
          {
            title: 'Research: drag physics constants',
            tags: [{ name: 'research', hue: 3 }],
            assignees: ['TJ'],
            unseen: 0,
            done: true,
          },
        ],
      },
    ],
  },
  drawer: {
    title: 'OKLCH palette generator',
    list: 'In progress',
    priority: 'High',
    tags: [
      { name: 'design', hue: 6 },
      { name: 'infra', hue: 5 },
    ],
    assignees: ['TJ', 'AK', 'RS'],
    description:
      'Generate the 8 tag hues at fixed L/C so chips read evenly. Stripe\u2019s finding: HSL lightness is perceptually broken \u2014 yellow reads lighter than blue at the same L. OKLCH fixes it; Tailwind 4 accepts it natively.',
    comments: [
      {
        who: 'KP',
        text: 'Dark-mode tints need their own L step \u2014 0.75 washes out on 0.17 surfaces.',
        at: '2h',
      },
      {
        who: 'AK',
        text: 'Agreed. I\u2019ll cut a variant at 0.70 and put both in the playground.',
        at: '1h',
      },
    ],
    activity: [
      'TJ moved this from Backlog to In progress \u00b7 3h ago',
      'AK assigned themselves \u00b7 2h ago',
      'KP linked tag \u201cinfra\u201d \u00b7 1h ago',
    ],
  },
  dashboard: {
    boards: [
      { name: 'Design system rollout', updated: '2m ago', members: 3, cards: 12 },
      { name: 'Q1 planning', updated: '1h ago', members: 2, cards: 8 },
      { name: 'Bug bash', updated: 'yesterday', members: 4, cards: 21 },
    ],
    updates: [
      { who: 'KP', text: 'commented on Card drawer IA rework', at: '12m' },
      { who: 'AK', text: 'moved OKLCH palette generator to In progress', at: '1h' },
      { who: 'RS', text: 'mentioned you in Bug bash chat', at: '3h' },
    ],
  },
  chat: {
    board: 'Design system rollout',
    messages: [
      { who: 'TJ', text: 'Palette\u2019s in the playground \u2014 flip the gray axis and tell me which reads calmer.', at: '09:12' },
      { who: 'KP', text: 'Warm, easily. The cool one feels like a terminal.', at: '09:14' },
      { who: 'AK', text: 'Counterpoint: cool matches the code chips. Try P4 + cool.', at: '09:15' },
    ],
  },
  profile: {
    name: 'Tejus Gupta',
    email: 'tejus@tejusgupta.dev',
    status: 'Building the design system',
    tokens: [
      { name: 'Claude Desktop', used: '2d ago' },
      { name: 'VS Code', used: 'today' },
    ],
  },
};
