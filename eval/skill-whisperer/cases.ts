// Authored and frozen before model calls. Labels never enter model requests.
// Multiple acceptable labels reflect overlapping skill descriptions.
type Case = {
  id: string;
  kind: "clear" | "boundary" | "none" | "history";
  prompt: string;
  expected: string[];
  history?: { role: "user" | "assistant"; content: string }[];
};

export const cases: Case[] = [
  { id: "landing", kind: "clear", prompt: "Build a polished landing page for my coffee subscription business.", expected: ["frontend-design"] },
  { id: "hover", kind: "clear", prompt: "Polish these buttons: the hover transitions, shadows and optical alignment feel off.", expected: ["make-interfaces-feel-better", "frontend-design"] },
  { id: "lcp", kind: "clear", prompt: "Audit why our storefront LCP is 6 seconds and find the render-blocking resources.", expected: ["web-perf"] },
  { id: "browser", kind: "clear", prompt: "Use a real browser from the terminal to reproduce this navigation bug and collect a trace.", expected: ["playwright"] },
  { id: "desktop", kind: "clear", prompt: "Capture a screenshot of my entire desktop.", expected: ["screenshot"] },
  { id: "ticket", kind: "clear", prompt: "Create a Linear issue for the broken login redirect with reproduction steps.", expected: ["linear"] },
  { id: "raster", kind: "clear", prompt: "Generate a watercolor illustration of a fox with a transparent background.", expected: ["imagegen"] },
  { id: "lego", kind: "clear", prompt: "Design a LEGO rally car using real available parts and compatible wheel arches.", expected: ["lego-car-design"] },
  { id: "zig", kind: "clear", prompt: "Fix this allocator ownership bug in my Zig 0.16 program.", expected: ["zig-0-16"] },
  { id: "create-skill", kind: "clear", prompt: "Turn our release procedure into a reusable Codex skill with a SKILL.md.", expected: ["skill-creator"] },
  { id: "install-skill", kind: "clear", prompt: "Install the skill from this GitHub repository into Codex.", expected: ["skill-installer"] },
  { id: "fleet-policy", kind: "clear", prompt: "Trim duplicate policy across our fleet agents shared prompt sections.", expected: ["fleet-prompt-editing"] },
  { id: "curate", kind: "clear", prompt: "Review my memory clusters and update durable knowledge about our project decisions.", expected: ["memory-curator"] },
  { id: "dossier", kind: "clear", prompt: "Review Jamie's recent conversations and update their PeopleSQL dossier with supported preferences.", expected: ["people-whisperer"] },
  { id: "pdf-form", kind: "clear", prompt: "Create a fillable PDF onboarding form and verify its rendered layout.", expected: ["pdf"] },
  { id: "slides", kind: "clear", prompt: "Create a PowerPoint deck from this product launch outline.", expected: ["Presentations"] },
  { id: "svg", kind: "boundary", prompt: "Edit the existing SVG icon code to improve its optical alignment. Do not generate a raster image.", expected: ["make-interfaces-feel-better", "frontend-design"] },
  { id: "lego-image", kind: "boundary", prompt: "Generate a photorealistic image of a LEGO sports car. I only want an image, not building instructions or real-part engineering.", expected: ["imagegen"] },
  { id: "car-repair", kind: "none", prompt: "My actual Honda car makes a grinding noise when braking. What might cause that?", expected: [] },
  { id: "linear-math", kind: "none", prompt: "Solve the linear equation 3x + 6 = 21.", expected: [] },
  { id: "pdf-word", kind: "none", prompt: "What do the letters PDF stand for? Just expand the acronym.", expected: [] },
  { id: "thanks", kind: "none", prompt: "Thanks, that is all I needed!", expected: [] },
  { id: "rewrite", kind: "none", prompt: "Rewrite this sentence more politely: send the report today.", expected: [] },
  { id: "arithmetic", kind: "none", prompt: "What is 19 times 7?", expected: [] },
  { id: "unsupported", kind: "none", prompt: "What are good vegetarian dinner ideas using chickpeas?", expected: [] },
  { id: "quoted-ticket", kind: "none", prompt: "Translate the phrase 'create a Linear ticket' into Spanish. Do not create any ticket.", expected: [] },
  { id: "install-not-author", kind: "boundary", prompt: "Download and install an existing skill from GitHub. Do not author a new skill.", expected: ["skill-installer"] },
  { id: "author-not-install", kind: "boundary", prompt: "Revise the instructions in my existing SKILL.md to make its trigger narrower. No installation needed.", expected: ["skill-creator"] },
  { id: "prompt-not-browser", kind: "boundary", prompt: "Rewrite our fleet policy about browser tool usage. This is prompt editing; don't operate a browser.", expected: ["fleet-prompt-editing"] },
  { id: "browser-not-prompt", kind: "boundary", prompt: "Use browser automation to check whether the search button works on localhost. This is not a fleet policy editing task.", expected: ["playwright"] },
  { id: "memory-not-person", kind: "boundary", prompt: "Curate our current database architecture decisions from memory clusters into a knowledge topic. Do not update anyone's dossier.", expected: ["memory-curator"] },
  { id: "person-not-memory", kind: "boundary", prompt: "Maintain Casey's PeopleSQL preferences and working-style dossier using recent session evidence, not a general knowledge file.", expected: ["people-whisperer"] },
  { id: "shift-math", kind: "history", history: [{ role: "user", content: "Audit our website performance, Lighthouse scores and slow LCP." }, { role: "assistant", content: "I found render-blocking resources and layout shifts in the storefront." }], prompt: "Unrelated question: what is 12 times 8?", expected: [] },
  { id: "shift-person", kind: "history", history: [{ role: "user", content: "Create a PowerPoint slide deck for the quarterly review." }, { role: "assistant", content: "The presentation is complete." }], prompt: "Now update Morgan's PeopleSQL dossier from our recent conversations.", expected: ["people-whisperer"] },
  { id: "continue-ui", kind: "history", history: [{ role: "user", content: "These card hover animations and shadows feel janky." }, { role: "assistant", content: "I can smooth their transitions and improve visual alignment." }], prompt: "Yes, please do that.", expected: ["make-interfaces-feel-better", "frontend-design"] },
  { id: "continue-install", kind: "history", history: [{ role: "user", content: "Can you install the existing skill from this GitHub repo?" }, { role: "assistant", content: "Yes, I can install it into Codex." }], prompt: "Go ahead.", expected: ["skill-installer"] },
  { id: "stop-browser", kind: "history", history: [{ role: "user", content: "Automate the browser to test the form." }, { role: "assistant", content: "Ready to run the browser test." }], prompt: "Stop. Do not run anything. Just acknowledge.", expected: [] },
  { id: "shift-pdf", kind: "history", history: [{ role: "user", content: "Design a LEGO car chassis using compatible bricks." }, { role: "assistant", content: "The car construction plan is ready." }], prompt: "Different task: inspect the layout of this PDF contract.", expected: ["pdf"] },
  { id: "continue-linear", kind: "history", history: [{ role: "user", content: "We should create a Linear ticket for this login bug." }, { role: "assistant", content: "I have the reproduction steps ready." }], prompt: "Please create it now.", expected: ["linear"] },
  { id: "shift-image", kind: "history", history: [{ role: "user", content: "Debug this Zig allocator crash." }, { role: "assistant", content: "The ownership bug is fixed." }], prompt: "New task: generate a watercolor landscape illustration.", expected: ["imagegen"] },
];
