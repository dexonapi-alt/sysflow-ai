/**
 * Comprehensive Frontend Design Intelligence System
 *
 * Contains hundreds of component inspirations, theme intelligence,
 * industry-aware palette selection, and layout patterns.
 *
 * The AI uses this as CREATIVE INSPIRATION — adapting ideas to each
 * unique project, never copying verbatim.
 */

// ─── Types ───

export interface DesignDirection {
  theme: "dark" | "light"
  palette: IndustryPalette
  mood: string
  pageType: string
  suggestedLayout: string
}

interface IndustryPalette {
  industry: string
  theme: "dark" | "light"
  colors: string
  mood: string
}

interface ComponentEntry {
  name: string
  description: string
}

// ─── Industry Detection & Palettes ───

const INDUSTRY_PALETTES: IndustryPalette[] = [
  { industry: "ai-tech", theme: "dark", colors: "deep navy/black bg, electric blue + cyan accents, white text — futuristic, technical, powerful", mood: "cutting-edge, innovative" },
  { industry: "developer-tools", theme: "dark", colors: "near-black bg, green/emerald terminal accents, monospace typography hints — hacker, technical", mood: "efficient, technical, sharp" },
  { industry: "saas-productivity", theme: "dark", colors: "dark charcoal bg, indigo/violet accents, clean sans-serif — professional but modern", mood: "clean, productive, trustworthy" },
  { industry: "fintech-banking", theme: "dark", colors: "deep dark bg, emerald/green accents for growth, gold for premium tiers — trust, security", mood: "secure, reliable, premium" },
  { industry: "crypto-web3", theme: "dark", colors: "black bg, multi-color gradients (purple→blue→cyan), neon accents — decentralized, futuristic", mood: "bold, decentralized, futuristic" },
  { industry: "cybersecurity", theme: "dark", colors: "black bg, red/crimson accents, matrix-green highlights — protective, serious", mood: "secure, vigilant, serious" },
  { industry: "gaming-esports", theme: "dark", colors: "black bg, neon green/purple/cyan accents, bold angular shapes — high energy", mood: "exciting, competitive, immersive" },
  { industry: "music-entertainment", theme: "dark", colors: "dark bg, vibrant pink/magenta + electric purple gradients — expressive, bold", mood: "dynamic, expressive, creative" },
  { industry: "creative-agency", theme: "dark", colors: "dark bg, mixed vibrant accents that break rules — unconventional, artistic", mood: "bold, creative, rule-breaking" },
  { industry: "portfolio-personal", theme: "dark", colors: "minimal dark bg, one signature accent color (your choice based on personality) — personal, focused", mood: "personal, curated, minimal" },
  { industry: "ecommerce-retail", theme: "light", colors: "white/cream bg, warm accents (coral, terracotta, amber) — inviting, shoppable", mood: "inviting, browse-friendly, warm" },
  { industry: "food-restaurant", theme: "light", colors: "warm white bg, amber/orange/red-brown accents — appetizing, welcoming", mood: "warm, appetizing, homey" },
  { industry: "health-wellness", theme: "light", colors: "soft white bg, sage/teal/mint accents — calm, natural, clean", mood: "calming, trustworthy, refreshing" },
  { industry: "education-learning", theme: "light", colors: "clean white bg, friendly blue/sky + orange accents — approachable, clear", mood: "friendly, structured, engaging" },
  { industry: "fashion-luxury", theme: "light", colors: "white bg, black text, minimal gold/blush accents — editorial, high-end", mood: "sophisticated, editorial, premium" },
  { industry: "real-estate", theme: "light", colors: "white/cream bg, navy/deep blue + gold accents — premium, aspirational", mood: "trustworthy, aspirational, premium" },
  { industry: "travel-hospitality", theme: "light", colors: "bright white bg, sky blue + warm orange/sunset accents — adventurous, inviting", mood: "adventurous, inspiring, visual" },
  { industry: "legal-corporate", theme: "light", colors: "white bg, navy/charcoal accents, minimal color — conservative, authoritative", mood: "professional, authoritative, conservative" },
  { industry: "nonprofit-social", theme: "light", colors: "white bg, warm green/teal + orange accents — compassionate, hopeful", mood: "compassionate, hopeful, community" },
  { industry: "kids-family", theme: "light", colors: "bright white bg, playful multi-color accents (primary colors) — fun, friendly", mood: "playful, fun, approachable" },
  { industry: "automotive", theme: "dark", colors: "black/dark gray bg, metallic silver + red accents — sleek, performance", mood: "sleek, powerful, premium" },
  { industry: "space-aerospace", theme: "dark", colors: "deep black bg, white stars, blue/purple nebula accents — vast, inspiring", mood: "vast, inspiring, ambitious" },
]

const INDUSTRY_KEYWORDS: Record<string, string[]> = {
  "ai-tech": ["ai", "artificial intelligence", "machine learning", "ml", "neural", "gpt", "llm", "model", "predict", "intelligent", "cognitive"],
  "developer-tools": ["developer", "dev tool", "api", "sdk", "cli", "terminal", "code", "deploy", "devops", "infrastructure", "database", "hosting"],
  "saas-productivity": ["saas", "productivity", "workflow", "project management", "collaboration", "team", "workspace", "notion", "task", "organize"],
  "fintech-banking": ["fintech", "banking", "payment", "finance", "investment", "trading", "wallet", "transaction", "money", "fund"],
  "crypto-web3": ["crypto", "web3", "blockchain", "nft", "defi", "token", "dao", "ethereum", "bitcoin", "solana", "wallet"],
  "cybersecurity": ["security", "cybersecurity", "firewall", "encrypt", "protect", "threat", "vulnerability", "privacy", "vpn", "auth"],
  "gaming-esports": ["gaming", "game", "esports", "play", "player", "tournament", "rpg", "multiplayer", "stream", "twitch"],
  "music-entertainment": ["music", "spotify", "playlist", "podcast", "stream", "audio", "sound", "band", "artist", "entertainment", "media"],
  "creative-agency": ["agency", "creative", "design agency", "studio", "branding", "marketing agency", "digital agency"],
  "portfolio-personal": ["portfolio", "personal", "resume", "cv", "freelance", "my work", "about me", "showcase"],
  "ecommerce-retail": ["ecommerce", "shop", "store", "product", "cart", "checkout", "buy", "retail", "marketplace", "sell"],
  "food-restaurant": ["food", "restaurant", "recipe", "menu", "cafe", "bakery", "delivery", "cooking", "chef", "kitchen", "meal", "order food"],
  "health-wellness": ["health", "wellness", "fitness", "yoga", "meditation", "mental health", "therapy", "doctor", "clinic", "nutrition", "gym"],
  "education-learning": ["education", "learning", "course", "school", "university", "tutorial", "student", "teach", "academy", "lms", "training"],
  "fashion-luxury": ["fashion", "luxury", "clothing", "brand", "wear", "style", "boutique", "couture", "apparel", "designer"],
  "real-estate": ["real estate", "property", "housing", "apartment", "rent", "home", "realty", "mortgage", "listing"],
  "travel-hospitality": ["travel", "hotel", "booking", "flight", "vacation", "tourism", "hostel", "adventure", "destination", "trip"],
  "legal-corporate": ["legal", "law", "corporate", "attorney", "consulting", "business", "firm", "enterprise", "professional service"],
  "nonprofit-social": ["nonprofit", "charity", "donate", "social", "volunteer", "cause", "foundation", "ngo", "community"],
  "kids-family": ["kids", "children", "family", "toy", "parenting", "baby", "childcare", "school", "kindergarten"],
  "automotive": ["car", "automotive", "vehicle", "drive", "auto", "motor", "electric vehicle", "ev", "tesla"],
  "space-aerospace": ["space", "aerospace", "rocket", "satellite", "nasa", "orbit", "launch", "mars", "astro"],
}

export function detectIndustry(prompt: string): IndustryPalette {
  const lower = prompt.toLowerCase()

  let bestMatch: string | null = null
  let bestScore = 0

  for (const [industry, keywords] of Object.entries(INDUSTRY_KEYWORDS)) {
    let score = 0
    for (const kw of keywords) {
      if (lower.includes(kw)) score++
    }
    if (score > bestScore) {
      bestScore = score
      bestMatch = industry
    }
  }

  if (bestMatch && bestScore > 0) {
    return INDUSTRY_PALETTES.find(p => p.industry === bestMatch)!
  }

  // Check for explicit theme preferences
  const wantsLight = /\b(light theme|white background|clean white|bright|minimal white|light mode)\b/i.test(prompt)
  const wantsDark = /\b(dark theme|dark mode|black background|dark background|night mode)\b/i.test(prompt)

  if (wantsLight) {
    return { industry: "generic", theme: "light", colors: "white bg, brand-appropriate accents — choose based on the product personality", mood: "clean, modern, professional" }
  }

  // Default to dark for startups/tech (most modern landing pages are dark)
  if (wantsDark || /\b(startup|saas|tech|app|platform|tool)\b/i.test(lower)) {
    return { industry: "startup-generic", theme: "dark", colors: "dark bg, choose accent colors that match the product's personality and energy", mood: "modern, ambitious, polished" }
  }

  return { industry: "generic", theme: "dark", colors: "choose theme and accent colors that best match the described product", mood: "modern, polished, professional" }
}

// ─── Page Type Detection ───

const PAGE_TYPE_KEYWORDS: Record<string, string[]> = {
  "landing-page": ["landing page", "landing", "homepage", "home page", "marketing page", "launch page"],
  "dashboard": ["dashboard", "admin", "analytics", "admin panel", "control panel", "cms", "management"],
  "portfolio": ["portfolio", "personal site", "my work", "resume", "cv", "showcase"],
  "blog": ["blog", "articles", "news", "posts", "content", "editorial", "magazine"],
  "ecommerce": ["shop", "store", "products", "cart", "ecommerce", "marketplace", "catalog"],
  "documentation": ["docs", "documentation", "api reference", "guide", "manual", "knowledge base"],
  "auth-pages": ["login", "signup", "sign up", "register", "authentication", "onboarding"],
  "pricing-page": ["pricing", "plans", "subscription", "billing"],
  "saas-landing": ["saas", "startup", "product launch", "waitlist", "beta"],
}

function detectPageType(prompt: string): string {
  const lower = prompt.toLowerCase()
  let best = "landing-page"
  let bestScore = 0

  for (const [pageType, keywords] of Object.entries(PAGE_TYPE_KEYWORDS)) {
    let score = 0
    for (const kw of keywords) {
      if (lower.includes(kw)) score++
    }
    if (score > bestScore) {
      bestScore = score
      best = pageType
    }
  }
  return best
}

// ─── Layout Patterns ───

const LAYOUT_SUGGESTIONS: Record<string, string[]> = {
  "landing-page": [
    "Nav → Hero → Social Proof logos → Features grid → How It Works steps → Testimonials → CTA banner → Footer",
    "Nav → Hero with product visual → Problem/Solution section → Feature spotlight (alternating rows) → Stats → Testimonials → Pricing → CTA → Footer",
    "Nav → Hero → Trusted-by logos → Bento feature grid → Single feature deep-dive → Testimonials marquee → FAQ → CTA → Footer",
  ],
  "saas-landing": [
    "Nav → Hero with app screenshot → Logo cloud → Feature bento grid → Integration section → Pricing toggle → Testimonials → CTA → Footer",
    "Nav → Hero → Problem statement → Solution/Features (tabs) → How it works (steps) → Pricing comparison → Social proof → CTA → Footer",
    "Nav → Announcement bar + Hero → Demo/preview section → Features (alternating) → Stats row → Testimonials → Pricing → FAQ → CTA → Footer",
  ],
  "dashboard": [
    "Sidebar nav → Top bar (search + avatar) → KPI card row → Charts row (2 charts) → Data table → Activity feed sidebar",
    "Top nav → KPI stats bar → Main content grid (charts + tables) → Right sidebar (notifications + activity)",
    "Collapsible sidebar → Command palette → KPI cards → Tabbed content area (overview, analytics, settings)",
  ],
  "portfolio": [
    "Nav → Hero (name + title + brief) → Selected work grid → About section → Skills/tools → Contact form → Footer",
    "Full-screen hero (name + role) → Horizontal scrolling project showcase → About with photo → Testimonials → Contact → Footer",
    "Minimal nav → Split hero (photo + intro) → Project cards with hover preview → Experience timeline → Contact → Footer",
  ],
  "blog": [
    "Nav → Featured post hero banner → Post card grid (3-col) → Newsletter CTA → Categories sidebar → Footer",
    "Nav → Search + filters → Masonry post grid → Load more → Newsletter banner → Footer",
    "Nav → Large featured post → Two-column list (posts + sidebar with categories/tags) → Newsletter → Footer",
  ],
  "ecommerce": [
    "Nav (with search + cart) → Hero banner/carousel → Featured products grid → Categories row → Testimonials → Newsletter → Footer",
    "Nav → Hero with promo → Product categories (horizontal scroll) → Best sellers grid → Why choose us → Reviews → Footer",
    "Nav → Full-width hero banner → New arrivals → Product grid with filters sidebar → Trust badges → Footer",
  ],
  "documentation": [
    "Sidebar (collapsible sections) → Top bar (search + theme toggle) → Breadcrumb → Content → Table of contents (right) → Prev/Next nav",
    "Top nav → Three-column: sidebar nav + content + on-page TOC → Code examples with copy button → Feedback widget",
  ],
  "auth-pages": [
    "Split screen: decorative visual (left) + form card (right) → Logo, heading, form fields, submit, alternative links",
    "Full-page gradient bg → Centered glass card → Logo, form, social auth buttons, switch between login/signup",
    "Minimal centered: logo at top → Form card → Footer links (terms, privacy)",
  ],
  "pricing-page": [
    "Nav → Hero heading + subtext → Monthly/Annual toggle → 3-column pricing cards → Feature comparison table → FAQ → CTA → Footer",
    "Nav → Headline → Pricing cards (popular highlighted) → Enterprise CTA → Testimonial → FAQ accordion → Footer",
  ],
}

// ─── Component Inspiration Catalog ───
// Each entry: concise visual description the AI adapts creatively.
// Organized by component type and theme suitability.

const CATALOG: Record<string, { dark?: string[], light?: string[], both?: string[] }> = {

  // ─── HEROES ───
  heroes: {
    dark: [
      "Centered Glow: massive headline centered on dark bg, large blurred ambient orb (brand color) behind text, small animated badge above headline ('Introducing v2'), two CTA buttons below, staggered fade-in entrance",
      "Split Product: headline + CTAs on left half, product screenshot in tilted browser/device frame on right, ambient glow behind product, content staggers in from left",
      "Particle Canvas: headline floating above animated particle/dot field background, single glowing CTA, minimal and futuristic, particles drift slowly",
      "Code Preview: bold headline on left, animated terminal/code editor on right showing product in action, syntax highlighting, cursor blink animation",
      "Video Background: looping dark ambient video behind gradient overlay, large bold headline fades through, cinematic entrance feel",
      "Floating Elements: centered headline with small UI cards/screenshots floating at various angles around it, each element animates in separately with different delays, parallax depth",
      "Gradient Mesh: 2-3 large overlapping blurred color blobs as background, clean white headline text centered, simple but visually striking",
      "Stats Below: bold headline + subtext, row of animated counter stats below (users, revenue, uptime), numbers count up on mount, credibility boost",
      "Morphing Words: headline with one rotating/morphing keyword that cycles through variations, static surrounding text, typewriter or morph animation draws attention",
      "3D Parallax Depth: layered elements at different z-levels, subtle mouse-follow parallax, foreground content + mid-ground accents + background glow, creates spatial depth",
      "Diagonal Split: dark angled section with headline overlapping a colored diagonal accent, dynamic composition breaking the grid",
      "Terminal Hero: full terminal UI as the hero — blinking cursor, typed commands, output revealing the product value, appeals to developers",
    ],
    light: [
      "Clean Centered: large headline on white bg, soft gray subtext, single colored CTA button, product screenshot or illustration below, gentle fade-in",
      "Split Illustration: headline + CTAs on left, custom illustration or product screenshot on right, light pastel accent shapes floating in background",
      "Image Showcase: full-width product screenshot in a device frame, headline and CTAs above, subtle shadow on the frame, clean and product-focused",
      "Massive Typography: single oversized headline (very large font weight), minimal subtext, one button, extreme whitespace around, editorial/luxury feel",
      "Card Preview: headline above, product UI embedded in a realistic device mockup below, subtle shadow lifts it off the page, scroll hint",
      "Geometric Accents: clean text with abstract geometric shapes (circles, squares, lines) as decorative accents in soft brand colors, modern and fresh",
      "Announcement + Hero: thin colored bar at top with news announcement, then clean hero below with headline + CTAs, logo cloud as social proof underneath",
      "Asymmetric Offset: headline positioned off-center left, visual element offset right, intentionally broken grid creates editorial interest, whitespace is deliberate",
      "Gradient Heading: white bg but the headline itself has a subtle brand-color gradient, drawing the eye to the text, rest is clean and minimal",
      "Testimonial Hero: large customer quote as the hero, with the product pitch woven in, builds trust immediately, author attribution below",
    ],
  },

  // ─── NAVIGATION ───
  navigation: {
    dark: [
      "Glass Scroll: transparent on load, transitions to frosted glass (backdrop-blur) on scroll with subtle bottom border appearing, logo left, links center, CTA right",
      "Floating Pill: detached from edges with margin, rounded-full pill shape, glass background, centered in page, premium and modern feel",
      "Minimal Stealth: solid dark bg blending with hero, logo left, sparse links right, nearly invisible until user scrolls and glass effect kicks in",
      "Command-bar Nav: navigation includes a ⌘K button or search trigger, appeals to keyboard-driven users, developer-oriented",
      "Sidebar Nav: vertical nav pinned to left edge for dashboards/apps, collapsible to icon-only mode, sections with dividers and badges",
    ],
    light: [
      "Clean White Bar: white bg with soft bottom shadow appearing on scroll, logo left, links center, colored CTA button right, professional",
      "Bordered Bottom: white bg with thin gray bottom border always visible, clean separation from content, traditional and reliable",
      "Transparent to Solid: transparent over hero, smoothly transitions to solid white bg with shadow as user scrolls past hero section",
      "Colored Accent Bar: navigation bar with brand-colored bg, white text and links, distinctive and brand-forward",
      "Sticky Minimal: very minimal — just logo and a hamburger/menu icon, maximizes content space, modern mobile-first approach",
    ],
  },

  // ─── FEATURE SECTIONS ───
  features: {
    both: [
      "Icon Card Grid (3-col): each card has icon in a colored/gradient container, feature title, short description — cards stagger-animate on scroll into view",
      "Alternating Rows: image/visual on one side, text/description on the other, rows alternate sides — each row scrolls in with fade-slide",
      "Bento Grid: mixed-size cards in a mosaic layout (Apple-style), some cards span 2 columns or 2 rows, creates visual variety and hierarchy",
      "Interactive Tabs: horizontal tab bar at top, clicking tabs smoothly switches the content/image below with cross-fade or slide transition",
      "Expandable Accordion: features as collapsible items, clicking one expands to reveal detail + visual while others collapse, clean and space-efficient",
      "Vertical Timeline: features along a center vertical line with alternating left/right content blocks, dots on the line, tells a progression story",
      "Single Spotlight: one feature gets an entire section — large visual on one side, detailed multi-paragraph description on the other, high emphasis",
      "Hover Reveal Cards: cards show icon + title normally, hovering smoothly reveals full description text or preview image underneath",
      "Numbered Steps: features presented as sequential steps (01, 02, 03), connected by a subtle line or arrow, guides user through a process",
      "Feature Comparison: two-column or multi-column table comparing 'without product' vs 'with product', or comparing plans, visual checkmarks",
      "Carousel Slider: features in a horizontal scrollable carousel, one or two visible at a time, arrows/dots for navigation, swipeable on mobile",
      "Code + Explanation: feature description on left, live code example or terminal output on right — appeals to developer audience, syntax highlighting",
      "Stats Integrated: each feature card includes a relevant stat (e.g., '10x faster'), number highlighted in brand color, quantifies the benefit",
      "Video Demos: each feature has a small looping video or GIF preview, plays on hover or when scrolled into view, shows the feature in action",
    ],
  },

  // ─── CARDS ───
  cards: {
    dark: [
      "Glass Surface: translucent bg (white/5%) with backdrop-blur, subtle white/10% border, hover lifts card 4-6px with transition, inner edge glow on hover",
      "Gradient Border Ring: dark card body with an animated gradient border that slowly shifts colors, eye-catching premium accent",
      "Accent Top Line: dark card with thin gradient line across the top edge (from-transparent via-brand to-transparent), icon + title + text below",
      "Neon Hover Glow: dark card that gains a colored box-shadow glow on hover in brand color, border brightens simultaneously, futuristic energy",
      "Minimal Dark: very subtle — barely visible border, dark bg matching page, only clear on hover when it lifts and border brightens, understated elegance",
      "Holographic: card with a subtle rainbow/holographic gradient that shifts based on mouse position or scroll, premium and unique feel",
    ],
    light: [
      "Elevated White: white bg card with soft multi-layered shadow, hover deepens shadow and lifts 2-4px, clean with generous internal padding",
      "Bordered Clean: white card with 1px gray border, no shadow, hover transitions border to brand color, minimal and sharp",
      "Pastel Accent Stripe: white card with colored left border stripe or top bar in category-appropriate pastel, visually organizes content",
      "Image Header: photo/illustration at the top of the card, title + description + CTA link below, magazine-style, good for blog posts or products",
      "Outline Minimal: just a thin border outline, lots of whitespace inside, text-focused, hover fills with very light brand-tinted bg",
      "Floating: white card with a large offset shadow that makes it appear to float significantly above the surface, dramatic depth effect",
    ],
    both: [
      "Horizontal Layout: image/icon on left third, text content on right two-thirds, works for blog listings, team members, or product items",
      "Stat/KPI Card: large number prominently displayed, label below, optional trend indicator (arrow up/down in green/red), dashboard essential",
      "Profile Card: avatar image at top (circular), name and role below, social links or contact at bottom, for team sections",
      "Expandable: compact summary by default, click toggles open to reveal full content with smooth height animation, space-efficient",
      "Badge/Tag: small colored badge in corner showing category, status, or label — helps with scannability in grids",
      "Testimonial Card: large quote marks at top, review text, star rating, author name + photo + company at bottom",
      "Pricing Card: plan name + price at top, feature list with checkmarks in middle, CTA button at bottom, optional 'Popular' badge",
      "Interactive Flip: card flips on hover to reveal back side with additional info, 3D transform animation, engaging interaction",
    ],
  },

  // ─── PRICING ───
  pricing: {
    both: [
      "3-Column Highlighted: three tier cards, the popular/recommended one is visually elevated (scaled up, accent border, or colored bg), 'Most Popular' badge on it",
      "Monthly/Annual Toggle: toggle switch above cards, switching animates the prices with a number transition, annual shows savings percentage badge",
      "Gradient Tier Accents: each tier card has a different accent color (matching tier level — basic: neutral, pro: brand, enterprise: premium gold/purple), increasing visual intensity",
      "Comparison Table Below: pricing cards at top for quick view, expandable or scrollable feature comparison table below for detailed comparison",
      "Usage Slider: single card with a draggable slider for usage amount, price updates dynamically as slider moves, for usage-based pricing models",
      "Enterprise Custom: 2-3 standard cards + one 'Enterprise' card with 'Contact Sales' instead of price, different visual treatment (outline vs filled)",
      "Horizontal Rows: pricing tiers as horizontal rows instead of cards, feature names inline, more scannable for many features, scrollable on mobile",
      "Minimal Clean: no card borders/shadows, just tier name, price in large text, bullet features below, separated by subtle dividers, Stripe-inspired",
    ],
  },

  // ─── TESTIMONIALS ───
  testimonials: {
    both: [
      "Large Single Quote: one testimonial fills the section — big quotation marks, large italic text, author photo + name + title + company below, fades between testimonials",
      "Card Grid: 2 or 3-column grid of testimonial cards with star ratings, quote text, and author details — stagger-animate on scroll",
      "Infinite Marquee: horizontal auto-scrolling row of testimonial cards that loops infinitely, pause on hover, creates a 'wall of love' social proof effect",
      "Social Media Style: testimonials styled like tweets or social posts — avatar, handle, timestamp, text — realistic social proof that feels genuine",
      "Video Testimonials: thumbnail cards with play button, clicking opens a modal with video playback, quote text extracted below each thumbnail",
      "Logo Cloud + Reveal: row of company/client logos, hovering or clicking a logo reveals that client's testimonial in a popup or expanding panel",
      "Before/After: split testimonials — left side shows the problem/pain, right side shows the transformation with the product, compelling narrative",
      "Rotating Carousel: single testimonial visible at a time, auto-rotates with slide/fade transition, dots or arrows for manual navigation, large and impactful",
      "Wall of Love: masonry grid of short testimonials/tweets, varying sizes, overwhelming social proof through volume, scroll-animated entrance",
    ],
  },

  // ─── CTA SECTIONS ───
  ctas: {
    dark: [
      "Gradient Banner: full-width section with brand gradient bg, centered bold headline, glowing/pulsing CTA button, creates a strong visual break",
      "Floating Card CTA: glass card floating with glow effect, centered text + button inside, surrounded by dark space, draws focus",
      "Animated Background CTA: animated particles, waves, or gradient shift behind the CTA text, creates energy and urgency",
      "Icon Marquee + CTA: decorative rows of slowly scrolling brand icons above and below the CTA text and button (like Magic UI), visual texture",
      "Spotlight CTA: single large ambient glow spotlight on the CTA area, rest of page dims, theatrical focus",
    ],
    light: [
      "Soft Gradient Banner: section with soft pastel gradient bg, centered text, colored CTA button, gentle and inviting feel",
      "Elevated Card CTA: white card elevated above a light gray bg section, centered text and button, focused island of action",
      "Split Action: headline text on left, email signup form (input + button) on right, divided by subtle brand accent, lead generation focused",
      "Whitespace CTA: just a large heading and button with extreme whitespace around, the emptiness itself draws attention to the message",
      "Image + CTA: split section with inspiring image on one side, headline + button on the other, visual motivation to act",
    ],
  },

  // ─── FOOTERS ───
  footers: {
    dark: [
      "Multi-Column Classic: logo + description in first col, then 3-4 link columns (Product, Company, Resources, Legal), social icons row at bottom, copyright",
      "Gradient Divider: thin gradient line at the top of footer separating it from content, organized link grid below, newsletter input optional",
      "Minimal Dark: single row — logo, inline essential links, copyright text — very clean, lots of spacing, suits minimal designs",
      "Decorated: decorative element above footer content (icon marquee, pattern, or gradient art), then standard link columns below, creates visual interest",
      "CTA + Footer Combo: newsletter signup section as the top of the footer area, link columns below it, combines two sections efficiently",
    ],
    light: [
      "Light Multi-Column: light gray bg section, organized link columns, social icons, clean and professional, newsletter field optional",
      "White Bordered: white bg with thin gray top border, clean link columns, minimal and sharp, suits professional/corporate sites",
      "Wave Separator: SVG wave shape at the top of footer creating organic transition from content, links below in organized columns",
      "Centered Minimal: everything centered — logo, then inline links, then social icons, then copyright — stacked vertically, very clean",
      "Card Footer: footer content in a rounded card that's slightly inset from page edges, different bg shade, feels contained and designed",
    ],
  },

  // ─── STATS / METRICS ───
  stats: {
    both: [
      "Counter Row: horizontal row of 3-4 large numbers with labels below, numbers animate (count up) when scrolled into view, impressive at a glance",
      "Stat Cards Grid: grid of small cards each with icon + large number + label + optional trend arrow (up/down in green/red), dashboard style",
      "Colored Banner Stripe: full-width colored bg strip with white stat numbers spread across, creates visual rhythm between sections",
      "Circular Progress: stats shown with circular ring/radial progress indicators, percentage-based metrics visualized, animated fill on scroll",
      "Icon + Number: each stat paired with a relevant icon above, organized in even grid, stagger-animate on scroll, clean and informative",
      "Comparison Stats: 'Before vs After' or 'Without vs With' stats side by side, dramatic difference highlighted, persuasive",
      "Inline Highlighted: stats woven into a sentence or paragraph, the numbers highlighted in brand color and larger font, natural and contextual",
      "Animated Progress Bars: horizontal progress bars that fill on scroll, percentage labels, good for skills/capabilities/benchmarks",
    ],
  },

  // ─── FAQ ───
  faq: {
    both: [
      "Smooth Accordion: expandable questions with height animation + chevron rotation, one open at a time, generous spacing between items, clean",
      "Two-Column: category list or search on the left, filtered questions/answers on the right, organized for large FAQ collections",
      "Searchable: search input at the top, FAQs filter in real-time as user types, instant feedback, great for large FAQ sets",
      "Tabbed by Topic: FAQ grouped by topic tabs (General, Billing, Technical, Account), switching tabs transitions the content smoothly",
      "Simple Inline: questions as styled bold headings, answers as paragraphs directly below, no accordion, straightforward scroll-through",
      "Card Per Question: each Q&A in its own card, cards in a grid or stacked list, hover highlights, feels organized and browseable",
    ],
  },

  // ─── TEAM / ABOUT ───
  team: {
    both: [
      "Avatar Grid: grid of circular photos with name + role below each, hover reveals bio or social links overlay, stagger-animate on scroll",
      "Large Profile Cards: cards with photo taking up half, name + role + bio text below, social icons at bottom, more detailed team display",
      "Carousel: horizontal scrollable team cards, one or two visible at a time, swipeable on mobile, for large teams",
      "Minimal List: text-only list with name, role, and linked social handles — no photos, ultra-clean and fast-loading",
      "Department Groups: team members grouped under department headings (Engineering, Design, Marketing), collapsible groups, organized",
      "Masonry: photos in varying sizes in a masonry grid, name overlay on hover, creative and visual, suits agencies/creative teams",
    ],
  },

  // ─── BLOG / ARTICLES ───
  blog: {
    both: [
      "Featured + Grid: large featured post hero card at top, remaining posts in 3-column card grid below, clear content hierarchy",
      "List with Thumbnails: vertical list — small thumbnail left, title + excerpt + date + category right, scannable and efficient",
      "Masonry Cards: posts in a masonry/pinterest-style grid, varying card heights based on content, category color tags, visual and browseable",
      "Magazine Split: large featured post on left taking 50% width, 2-3 smaller stacked posts on right taking 50%, editorial layout",
      "Minimal Text: just post titles, dates, and maybe category — no images, no excerpts, extremely clean, suits technical blogs",
      "Card Grid with Filters: filterable category tabs above, post card grid below that filters with animation, interactive and organized",
    ],
  },

  // ─── FORMS / AUTH ───
  forms: {
    dark: [
      "Glass Card Centered: frosted glass card centered on dark bg with ambient glow behind, logo + heading + form fields + submit inside, premium login feel",
      "Split Dark: dark decorative visual/pattern on left half, dark form card on right half, two-panel login that feels immersive",
      "Minimal Dark: very simple — logo, inputs, button on a dark bg, no card boundary, floating in space, futuristic minimalism",
      "Terminal Auth: login form styled like a terminal/command line, monospace font, blinking cursor, appeals to developer products",
    ],
    light: [
      "Split Bright: colorful illustration or product screenshot on left, clean white form card on right, friendly and welcoming onboarding feel",
      "Centered Elevated Card: white card with shadow centered on light gray bg, logo at top, form fields, social auth divider, clean and trustworthy",
      "Full-Page Gradient: soft gradient bg covering the full page, white form card floating on it, beautiful and inviting",
      "Step-by-Step Wizard: multi-step form with progress bar at top, one step at a time, forward/back buttons, smooth step transitions",
    ],
    both: [
      "Social Auth Options: social login buttons (Google, GitHub, etc.) prominently displayed above or alongside email/password form, 'OR' divider between",
      "Inline Validation: form fields show real-time validation with animated feedback (green check, red shake + error message), responsive feel",
      "Magic Link: email-only input for passwordless auth, clean and simple, 'Check your email' confirmation screen with animated mail icon",
    ],
  },

  // ─── DASHBOARD COMPONENTS ───
  dashboard: {
    both: [
      "Sidebar + Main: collapsible sidebar nav with icon + text labels, sections with dividers, main content area on right, top bar with search + user avatar",
      "KPI Card Row: top row of 4 metric cards — each with title, large number, sparkline or trend arrow, color-coded positive/negative trends",
      "Data Table: sortable columns, clickable rows, row hover highlight, pagination or infinite scroll, action dropdown per row, responsive on mobile",
      "Chart Panel: card containing a responsive line/bar/area chart, time range selector buttons (7d, 30d, 90d, 1y), tooltip on hover over data points",
      "Activity Timeline: vertical timeline of recent events, each with icon + description + relative timestamp, scrollable, filterable by type",
      "Command Palette: ⌘K triggered modal — search input, categorized results (pages, actions, recent), keyboard navigable with arrow keys",
      "Kanban Columns: column-based layout with draggable cards, column headers with count badge, add-card button per column, horizontal scroll if many columns",
      "Notification Dropdown: bell icon with unread count badge, dropdown shows notification list with read/unread states, mark all read action",
      "Settings Panel: tabbed or sidebar settings layout, form sections for different categories, save/discard buttons, change indicators",
      "Empty States: illustrated empty state screens for no-data situations, friendly message, CTA to create first item, not just blank space",
    ],
  },

  // ─── DECORATIVE / AMBIENT TECHNIQUES ───
  decorative: {
    dark: [
      "Ambient Glow Orb: large (300-600px) blurred circle in brand color at 10-20% opacity, positioned behind hero or key content, creates focal warmth",
      "Dot Grid Pattern: subtle repeating dot pattern on background at 5% opacity, adds texture without distraction, technical/modern feel",
      "Gradient Mesh: 2-3 large overlapping blurred color blobs creating organic abstract gradient, background or hero decoration, each site uses different colors",
      "Floating Geometry: small geometric shapes (circles, hexagons, diamonds) slowly floating with CSS animation, parallax-layer background decoration",
      "Noise/Grain Overlay: subtle film grain texture overlay on dark backgrounds at low opacity, adds tactile analog quality, premium feel",
      "Animated Gradient Border: card or section border with gradient that slowly rotates/shifts, draws subtle attention, premium accent",
      "Aurora Waves: flowing gradient bands resembling northern lights, slow undulating animation, dramatic and beautiful hero background",
      "Grid Lines Background: faint grid of straight lines on dark bg at 3-5% opacity, architectural/technical feel, depth cue",
      "Scroll Parallax Layers: background elements (shapes, glows) move at different speeds on scroll, creates spatial depth and engagement",
      "Icon Marquee Band: rows of slowly scrolling semi-transparent icons as a decorative band between sections, creates visual texture (like Magic UI footer)",
      "Spotlight Cone: triangular or conical gradient light beam from top of page pointing down, theatrical lighting effect, focuses attention",
      "Star Field: tiny random dots resembling stars on dark bg, optional very slow drift animation, cosmic/space feel",
    ],
    light: [
      "Soft Shadow Layers: multi-layered shadows at different offsets and opacities on cards, creates realistic depth, premium tactile quality",
      "Pastel Background Blobs: light pastel-colored organic shapes in background (very low saturation), friendly and modern, not distracting",
      "Subtle Pattern Texture: faint geometric repeating pattern (chevrons, waves, crosses) in light gray, adds texture to white sections",
      "Wave/Curve Dividers: SVG wave or curve shapes between sections instead of straight lines, adds organic flow and visual interest",
      "Gradient Tint: very subtle gradient overlay on section backgrounds (e.g., white to very-light-brand-color), barely noticeable warmth/coolness",
      "Scattered Dots: random small dots in light gray scattered across a section background, playful texture, casual feel",
      "Line Art Accents: thin decorative line art (geometric or organic) as section decorations, drawn with brand color at low opacity",
    ],
  },

  // ─── SOCIAL PROOF ───
  socialProof: {
    both: [
      "Logo Cloud Row: horizontal row of grayscale client/partner logos, subtle opacity, hover brightens individual logo, 'Trusted by' heading above",
      "Logo Marquee: auto-scrolling infinite horizontal loop of logos, smooth continuous motion, no gaps, professional trust signal",
      "Press Mentions: 'As seen in' section with publication logos (TechCrunch, Forbes, etc.) and optional quote snippets",
      "User Count Banner: 'Join 10,000+ teams' with animated counter, paired with small avatar stack showing real user photos",
      "Rating Badges: aggregate ratings from G2, Capterra, ProductHunt, etc. displayed as badge icons with star ratings",
      "Integration Logos: 'Integrates with' section showing logos of compatible tools/services, clicking opens integration detail",
    ],
  },

  // ─── 404 / ERROR PAGES ───
  errorPages: {
    both: [
      "Illustrated 404: large playful illustration (lost astronaut, broken robot, empty landscape), headline, back-to-home button, turn errors into charm",
      "Minimal 404: giant '404' number in brand color, brief message below, search bar or navigation links to help user recover",
      "Interactive 404: mini-game or interactive element on the error page (bouncing ball, drawing canvas), memorable and delightful",
      "Animated 404: the '404' text or illustration has a subtle loop animation, parallax mouse follow, or glitch effect, engaging despite the error",
    ],
  },

  // ─── LOADING / SKELETON STATES ───
  loading: {
    both: [
      "Skeleton Shimmer: placeholder blocks matching content layout, subtle shimmer/pulse animation sweeping across, indicates loading without spinner",
      "Progress Bar: thin colored bar at very top of page that fills from left to right, minimal and familiar (like YouTube/GitHub)",
      "Branded Spinner: custom animated logo or brand icon as loading indicator, centered on page, brand-reinforcing idle state",
      "Staggered Skeletons: skeleton blocks that appear with staggered animation, mimicking the staggered entrance of real content, smooth",
    ],
  },
}

// ─── Selection & Brief Building ───

function selectRelevantCategories(pageType: string): string[] {
  const base = ["heroes", "navigation", "features", "cards", "decorative"]

  const PAGE_CATEGORIES: Record<string, string[]> = {
    "landing-page": [...base, "testimonials", "ctas", "stats", "socialProof", "footers", "faq"],
    "saas-landing": [...base, "pricing", "testimonials", "ctas", "stats", "socialProof", "footers", "faq"],
    "dashboard": ["dashboard", "cards", "navigation", "loading"],
    "portfolio": ["heroes", "navigation", "cards", "decorative", "footers", "forms"],
    "blog": ["heroes", "navigation", "blog", "cards", "ctas", "footers"],
    "ecommerce": ["heroes", "navigation", "cards", "features", "testimonials", "ctas", "footers", "socialProof"],
    "documentation": ["navigation", "cards"],
    "auth-pages": ["forms", "decorative"],
    "pricing-page": ["navigation", "pricing", "faq", "testimonials", "ctas", "footers"],
  }

  return PAGE_CATEGORIES[pageType] || base
}

function pickEntries(category: string, theme: "dark" | "light", maxPerCategory: number): string[] {
  const cat = CATALOG[category]
  if (!cat) return []

  const pool: string[] = []
  const themed = theme === "dark" ? cat.dark : cat.light
  if (themed) pool.push(...themed)
  if (cat.both) pool.push(...cat.both)

  // Shuffle and pick up to maxPerCategory
  const shuffled = pool.sort(() => Math.random() - 0.5)
  return shuffled.slice(0, maxPerCategory)
}

// ─── Main Export ───

/**
 * Builds a focused, prompt-aware design brief. Analyzes the user's prompt to:
 * 1. Detect industry → select appropriate color palette and mood
 * 2. Detect page type → select relevant layout and component categories
 * 3. Pick inspiring component descriptions from the catalog
 *
 * Returns a concise brief the AI uses as creative inspiration.
 */
export function buildDesignBrief(prompt: string): string {
  const palette = detectIndustry(prompt)
  const pageType = detectPageType(prompt)
  const categories = selectRelevantCategories(pageType)
  const layouts = LAYOUT_SUGGESTIONS[pageType] || LAYOUT_SUGGESTIONS["landing-page"]!

  // Pick a layout suggestion
  const layoutSuggestion = layouts[Math.floor(Math.random() * layouts.length)]!

  const lines: string[] = [
    "═══ DESIGN BRIEF (tailored to this project) ═══",
    "",
    `DETECTED: ${palette.industry} / ${pageType}`,
    "",
    "── THEME & COLOR DIRECTION ──",
    `Theme: ${palette.theme}`,
    `Palette: ${palette.colors}`,
    `Mood: ${palette.mood}`,
    "Choose specific Tailwind color shades that match this direction.",
    "Do NOT reuse colors from previous projects — each project gets its own palette.",
    "",
    "── SUGGESTED LAYOUT FLOW ──",
    layoutSuggestion,
    "(Adapt this flow to fit the actual content needed — add, remove, or reorder sections as appropriate.)",
    "",
    "── COMPONENT INSPIRATION ──",
    "Pick and adapt ideas from below. Do NOT copy descriptions literally — design original components inspired by these concepts:",
    "",
  ]

  const maxPerCategory = categories.length > 8 ? 2 : 3

  for (const cat of categories) {
    const entries = pickEntries(cat, palette.theme, maxPerCategory)
    if (entries.length === 0) continue

    lines.push(`▸ ${cat.toUpperCase()}:`)
    for (const entry of entries) {
      lines.push(`  • ${entry}`)
    }
    lines.push("")
  }

  lines.push("── CRITICAL REMINDERS ──")
  lines.push("• Design for THIS brand — use the actual product name, write unique copy, choose brand-appropriate colors")
  lines.push("• Every page must have: entrance animations, scroll reveals, hover feedback, responsive breakpoints")
  lines.push("• Vary your design choices — don't reuse the same patterns for every project")
  lines.push("• DEPS: NEVER rewrite package.json. List extra packages in completion summary.")
  lines.push("")
  lines.push("═══ END DESIGN BRIEF ═══")

  return lines.join("\n")
}
