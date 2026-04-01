/**
 * Concrete Component Code Templates — actual Tailwind + React patterns the AI can use.
 *
 * Unlike the design-system which provides creative descriptions,
 * this module provides EXECUTABLE code the AI can adapt.
 * Each template is a minimal, working snippet.
 */

// ─── Hero Section Templates ───

export const HERO_TEMPLATES = `
## HERO — Centered Glow (Dark, SaaS)
\`\`\`tsx
<section className="relative min-h-screen bg-black overflow-hidden flex items-center justify-center">
  {/* Ambient glow */}
  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-blue-500/20 rounded-full blur-[120px]" />
  <div className="absolute top-1/3 right-1/4 w-[400px] h-[400px] bg-cyan-500/10 rounded-full blur-[100px]" />

  <div className="relative z-10 max-w-4xl mx-auto px-6 text-center">
    {/* Badge */}
    <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-white/10 bg-white/5 backdrop-blur-sm text-sm text-white/70 mb-8">
      <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
      Now in public beta
    </div>

    <h1 className="text-5xl md:text-7xl font-bold text-white tracking-tight leading-[1.1] mb-6">
      Build workflows that
      <span className="bg-gradient-to-r from-blue-400 via-cyan-400 to-emerald-400 bg-clip-text text-transparent"> think for you</span>
    </h1>

    <p className="text-lg md:text-xl text-neutral-400 max-w-2xl mx-auto mb-10 leading-relaxed">
      Connect your tools, automate operations, and let AI orchestrate the complexity. Ship faster with less friction.
    </p>

    <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
      <button className="px-8 py-3.5 rounded-xl bg-white text-black font-semibold hover:bg-neutral-200 transition-all shadow-lg shadow-white/10">
        Start free trial
      </button>
      <button className="px-8 py-3.5 rounded-xl border border-white/15 text-white hover:bg-white/5 transition-all">
        Watch demo
      </button>
    </div>
  </div>
</section>
\`\`\`

## HERO — Split with Product Screenshot
\`\`\`tsx
<section className="relative bg-neutral-950 overflow-hidden">
  <div className="max-w-7xl mx-auto px-6 py-24 lg:py-32">
    <div className="grid lg:grid-cols-2 gap-16 items-center">
      <div>
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-sm mb-6">
          Trusted by 500+ teams
        </div>
        <h1 className="text-4xl md:text-6xl font-bold text-white tracking-tight leading-[1.1] mb-6">
          Your AI-powered<br />operations hub
        </h1>
        <p className="text-lg text-neutral-400 mb-8 leading-relaxed max-w-lg">
          Orchestrate workflows, automate tasks, and connect every tool in your stack — all from one intelligent platform.
        </p>
        <div className="flex gap-4">
          <button className="px-6 py-3 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-500 transition-colors">
            Get started free
          </button>
          <button className="px-6 py-3 rounded-lg border border-white/15 text-white hover:bg-white/5 transition-colors">
            Book a demo
          </button>
        </div>
      </div>

      {/* Product preview */}
      <div className="relative">
        <div className="absolute inset-0 bg-gradient-to-tr from-blue-500/20 via-transparent to-cyan-500/20 rounded-2xl blur-2xl" />
        <div className="relative rounded-2xl border border-white/10 bg-neutral-900/80 backdrop-blur-sm p-2 shadow-2xl">
          <div className="rounded-xl bg-neutral-900 p-6 min-h-[400px] flex items-center justify-center text-neutral-500">
            {/* Replace with actual dashboard screenshot or mockup */}
            <div className="text-center">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-500 to-cyan-500 mx-auto mb-4 flex items-center justify-center text-white text-2xl font-bold">C</div>
              <p className="text-neutral-400">Dashboard Preview</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>
\`\`\`
`

// ─── Navigation Templates ───

export const NAV_TEMPLATES = `
## NAVBAR — Glass Scroll (Sticky, Dark)
\`\`\`tsx
<nav className="fixed top-0 left-0 right-0 z-50 border-b border-white/5 bg-black/60 backdrop-blur-xl">
  <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
    <div className="flex items-center gap-2">
      <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center text-white font-bold text-sm">C</div>
      <span className="text-white font-semibold text-lg">CatelisAI</span>
    </div>

    <div className="hidden md:flex items-center gap-8">
      <a href="#features" className="text-sm text-neutral-400 hover:text-white transition-colors">Features</a>
      <a href="#pricing" className="text-sm text-neutral-400 hover:text-white transition-colors">Pricing</a>
      <a href="#docs" className="text-sm text-neutral-400 hover:text-white transition-colors">Docs</a>
    </div>

    <div className="flex items-center gap-3">
      <button className="text-sm text-neutral-400 hover:text-white transition-colors">Log in</button>
      <button className="px-4 py-2 rounded-lg bg-white text-black text-sm font-medium hover:bg-neutral-200 transition-colors">
        Get started
      </button>
    </div>
  </div>
</nav>
\`\`\`
`

// ─── Feature Section Templates ───

export const FEATURE_TEMPLATES = `
## FEATURES — Icon Card Grid (Dark)
\`\`\`tsx
<section className="bg-neutral-950 py-24">
  <div className="max-w-7xl mx-auto px-6">
    <div className="text-center mb-16">
      <p className="text-sm font-medium text-blue-400 mb-3">Features</p>
      <h2 className="text-3xl md:text-5xl font-bold text-white tracking-tight mb-4">
        Everything you need to automate
      </h2>
      <p className="text-neutral-400 max-w-2xl mx-auto text-lg">
        A complete toolkit for building, deploying, and managing intelligent workflows.
      </p>
    </div>

    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
      {features.map((feature, i) => (
        <div key={i} className="group p-6 rounded-2xl border border-white/5 bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/10 transition-all duration-300">
          <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center mb-4">
            <span className="text-blue-400 text-lg">{feature.icon}</span>
          </div>
          <h3 className="text-lg font-semibold text-white mb-2">{feature.title}</h3>
          <p className="text-neutral-400 text-sm leading-relaxed">{feature.description}</p>
        </div>
      ))}
    </div>
  </div>
</section>
\`\`\`

## FEATURES — Bento Grid (Apple-style)
\`\`\`tsx
<section className="bg-black py-24">
  <div className="max-w-7xl mx-auto px-6">
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {/* Large card spanning 2 columns */}
      <div className="lg:col-span-2 relative overflow-hidden rounded-3xl border border-white/5 bg-neutral-900/50 p-8 min-h-[320px]">
        <div className="absolute bottom-0 right-0 w-[400px] h-[300px] bg-gradient-to-tl from-blue-500/10 to-transparent rounded-tl-[100px]" />
        <p className="text-sm text-blue-400 font-medium mb-2">AI Orchestration</p>
        <h3 className="text-2xl font-bold text-white mb-3">Workflows that think</h3>
        <p className="text-neutral-400 max-w-md">Let AI decide the optimal path through your automation pipeline — adapting to errors, load, and context in real-time.</p>
      </div>

      {/* Tall card */}
      <div className="row-span-2 rounded-3xl border border-white/5 bg-neutral-900/50 p-8 flex flex-col justify-between min-h-[320px]">
        <div>
          <p className="text-sm text-emerald-400 font-medium mb-2">Integrations</p>
          <h3 className="text-2xl font-bold text-white mb-3">200+ connectors</h3>
          <p className="text-neutral-400 text-sm">Plug into every tool your team uses — from Slack to Salesforce, GitHub to BigQuery.</p>
        </div>
        <div className="grid grid-cols-4 gap-3 mt-6">
          {["Slack", "Git", "AWS", "GCP", "Jira", "PG", "K8s", "API"].map((t) => (
            <div key={t} className="aspect-square rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-xs text-neutral-400">{t}</div>
          ))}
        </div>
      </div>

      {/* Two small cards */}
      <div className="rounded-3xl border border-white/5 bg-neutral-900/50 p-8">
        <p className="text-sm text-violet-400 font-medium mb-2">Speed</p>
        <h3 className="text-4xl font-bold text-white mb-2">10x</h3>
        <p className="text-neutral-400 text-sm">Faster deployment than manual workflows</p>
      </div>
      <div className="rounded-3xl border border-white/5 bg-neutral-900/50 p-8">
        <p className="text-sm text-amber-400 font-medium mb-2">Reliability</p>
        <h3 className="text-4xl font-bold text-white mb-2">99.9%</h3>
        <p className="text-neutral-400 text-sm">Uptime with automatic failover and recovery</p>
      </div>
    </div>
  </div>
</section>
\`\`\`
`

// ─── Social Proof / Logo Cloud ───

export const SOCIAL_PROOF_TEMPLATES = `
## SOCIAL PROOF — Logo Cloud
\`\`\`tsx
<section className="border-y border-white/5 bg-black/50 py-12">
  <div className="max-w-7xl mx-auto px-6">
    <p className="text-center text-sm text-neutral-500 mb-8">Trusted by teams at</p>
    <div className="flex flex-wrap items-center justify-center gap-x-12 gap-y-6">
      {["Vercel", "Stripe", "Linear", "Notion", "Figma", "Supabase"].map((name) => (
        <span key={name} className="text-neutral-500 text-lg font-medium">{name}</span>
      ))}
    </div>
  </div>
</section>
\`\`\`
`

// ─── CTA Templates ───

export const CTA_TEMPLATES = `
## CTA — Gradient Banner
\`\`\`tsx
<section className="relative bg-black py-24 overflow-hidden">
  <div className="absolute inset-0 bg-gradient-to-r from-blue-500/10 via-cyan-500/5 to-emerald-500/10" />
  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-blue-500/10 rounded-full blur-[100px]" />

  <div className="relative z-10 max-w-3xl mx-auto px-6 text-center">
    <h2 className="text-3xl md:text-5xl font-bold text-white tracking-tight mb-6">
      Ready to automate your workflows?
    </h2>
    <p className="text-lg text-neutral-400 mb-10 max-w-xl mx-auto">
      Join hundreds of teams shipping faster with intelligent automation. Start free, scale when ready.
    </p>
    <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
      <button className="px-8 py-4 rounded-xl bg-white text-black font-semibold text-lg hover:bg-neutral-200 transition-all shadow-lg shadow-white/10">
        Start building free
      </button>
      <button className="px-8 py-4 rounded-xl border border-white/15 text-white hover:bg-white/5 transition-all">
        Talk to sales
      </button>
    </div>
  </div>
</section>
\`\`\`
`

// ─── Testimonial Templates ───

export const TESTIMONIAL_TEMPLATES = `
## TESTIMONIALS — Card Grid
\`\`\`tsx
<section className="bg-neutral-950 py-24">
  <div className="max-w-7xl mx-auto px-6">
    <div className="text-center mb-16">
      <h2 className="text-3xl md:text-4xl font-bold text-white tracking-tight mb-4">Loved by teams</h2>
      <p className="text-neutral-400">See what our users are saying</p>
    </div>

    <div className="grid md:grid-cols-3 gap-6">
      {testimonials.map((t, i) => (
        <div key={i} className="p-6 rounded-2xl border border-white/5 bg-white/[0.02]">
          <p className="text-neutral-300 text-sm leading-relaxed mb-6">"{t.quote}"</p>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center text-white font-medium text-sm">
              {t.name[0]}
            </div>
            <div>
              <p className="text-white text-sm font-medium">{t.name}</p>
              <p className="text-neutral-500 text-xs">{t.role}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  </div>
</section>
\`\`\`
`

// ─── Footer Templates ───

export const FOOTER_TEMPLATES = `
## FOOTER — Minimal Dark
\`\`\`tsx
<footer className="border-t border-white/5 bg-black py-16">
  <div className="max-w-7xl mx-auto px-6">
    <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-12">
      <div>
        <h4 className="text-white font-semibold text-sm mb-4">Product</h4>
        <ul className="space-y-2.5">
          {["Features", "Pricing", "Integrations", "Changelog"].map((item) => (
            <li key={item}><a href="#" className="text-neutral-500 text-sm hover:text-white transition-colors">{item}</a></li>
          ))}
        </ul>
      </div>
      <div>
        <h4 className="text-white font-semibold text-sm mb-4">Company</h4>
        <ul className="space-y-2.5">
          {["About", "Blog", "Careers", "Contact"].map((item) => (
            <li key={item}><a href="#" className="text-neutral-500 text-sm hover:text-white transition-colors">{item}</a></li>
          ))}
        </ul>
      </div>
      <div>
        <h4 className="text-white font-semibold text-sm mb-4">Resources</h4>
        <ul className="space-y-2.5">
          {["Documentation", "API Reference", "Community", "Status"].map((item) => (
            <li key={item}><a href="#" className="text-neutral-500 text-sm hover:text-white transition-colors">{item}</a></li>
          ))}
        </ul>
      </div>
      <div>
        <h4 className="text-white font-semibold text-sm mb-4">Legal</h4>
        <ul className="space-y-2.5">
          {["Privacy", "Terms", "Security"].map((item) => (
            <li key={item}><a href="#" className="text-neutral-500 text-sm hover:text-white transition-colors">{item}</a></li>
          ))}
        </ul>
      </div>
    </div>
    <div className="flex flex-col md:flex-row items-center justify-between pt-8 border-t border-white/5">
      <p className="text-neutral-500 text-sm">&copy; 2026 CatelisAI. All rights reserved.</p>
      <div className="flex gap-6 mt-4 md:mt-0">
        {["Twitter", "GitHub", "Discord"].map((s) => (
          <a key={s} href="#" className="text-neutral-500 text-sm hover:text-white transition-colors">{s}</a>
        ))}
      </div>
    </div>
  </div>
</footer>
\`\`\`
`

// ─── Utility Patterns ───

export const UTILITY_PATTERNS = `
## TAILWIND PATTERNS — Essential Design Tokens

### Glass Surface
\`className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl"\`

### Gradient Text
\`className="bg-gradient-to-r from-blue-400 via-cyan-400 to-emerald-400 bg-clip-text text-transparent"\`

### Ambient Glow Orb
\`className="absolute w-[500px] h-[500px] bg-blue-500/20 rounded-full blur-[120px]"\`

### Hover Card Effect
\`className="group p-6 rounded-2xl border border-white/5 bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/10 transition-all duration-300"\`

### Badge / Pill
\`className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-sm"\`

### Section Heading Pattern
\`\`\`tsx
<div className="text-center mb-16">
  <p className="text-sm font-medium text-blue-400 mb-3">Section Label</p>
  <h2 className="text-3xl md:text-5xl font-bold text-white tracking-tight mb-4">Main Heading</h2>
  <p className="text-neutral-400 max-w-2xl mx-auto text-lg">Supporting description text.</p>
</div>
\`\`\`

### Spacing Rhythm
- Section padding: \`py-24\` (consistent vertical rhythm)
- Container: \`max-w-7xl mx-auto px-6\`
- Card padding: \`p-6\` or \`p-8\`
- Gap between cards: \`gap-6\`
- Heading to content: \`mb-4\` to \`mb-6\`
- Content to CTA: \`mb-8\` to \`mb-10\`

### Typography Scale
- Hero: \`text-5xl md:text-7xl font-bold tracking-tight\`
- Section heading: \`text-3xl md:text-5xl font-bold tracking-tight\`
- Card heading: \`text-lg font-semibold\`
- Body: \`text-neutral-400 text-sm leading-relaxed\` or \`text-lg\`
- Label: \`text-sm font-medium text-blue-400\`

### Color System (Dark Theme)
- Background: \`bg-black\` or \`bg-neutral-950\`
- Card bg: \`bg-white/[0.02]\` or \`bg-neutral-900/50\`
- Borders: \`border-white/5\` or \`border-white/10\`
- Heading text: \`text-white\`
- Body text: \`text-neutral-400\`
- Muted text: \`text-neutral-500\`
- Accent: \`text-blue-400\`, \`bg-blue-500\`
`

// ─── Build the full template reference ───

export function getComponentTemplates(): string {
  return [
    "═══ COMPONENT CODE TEMPLATES ═══",
    "Use these as STARTING POINTS. Adapt colors, copy, and structure to the specific project.",
    "Each template is production-ready Tailwind + React. Customize, don't copy blindly.",
    "",
    UTILITY_PATTERNS,
    NAV_TEMPLATES,
    HERO_TEMPLATES,
    SOCIAL_PROOF_TEMPLATES,
    FEATURE_TEMPLATES,
    TESTIMONIAL_TEMPLATES,
    CTA_TEMPLATES,
    FOOTER_TEMPLATES,
    "═══ END TEMPLATES ═══"
  ].join("\n")
}

/**
 * Get a compact version with just utility patterns (for tool-result rounds).
 */
export function getCompactTemplateReminder(): string {
  return UTILITY_PATTERNS
}
