# Community pass 2: study communities, hand-drawn/visual practice, picture mnemonics, and what makes mind maps look good (as of Nov 2026)

Method note: about 44 tool calls. Pass 1 (`community_voice_and_best_practice.md`) is not repeated. Frequency tags: COMMON = several independent sources; SOME = 2-3; ONE-OFF = single voice. "Snippet" means I only saw a search-result summary, not the page.

Access failures (stated plainly, nothing worked around): StudentDoctor forum threads returned 403; the Mac Power Users thread returned 404 on fetch; Reddit was not reachable in pass 1 and I did not attempt it; icanstudy.com guessed URLs returned 404 (Justin Sung's own words were NOT obtained); the UTAR competition rules PDF failed on a certificate error; the BMC mind-map rubric table redirected to a login/authorise page; Capterra, G2, Trustpilot and Miro community pages were seen only as search snippets. Hacker News via the Algolia API did work. Search tool summaries are model-written, so anything marked snippet is second-hand.

## 1. Community recommendations and complaints (Hacker News 2024-2026, review sites)

### Takeaway
Newer HN comments (mostly 2025-2026) are dominated by people building their own mind-map/AI tools, with a clear thread of "local-first, no cloud, plain markdown". Recommendation of named products is thin; MindNode gets warm praise as an Apple-only product. Complaints on review sites cluster on subscriptions, not on map features.

### Cited Findings
- MindNode praise, Mac-centric: GeneralMaximus (2024-05-24): "MindNode is my favorite app to fire up when I need to break down a big idea"; the same commenter says nothing like it exists on Windows or Linux. jen729w (2024-06-09): "MindNode is a delightful mind mapping app." (COMMON as praise, but it is Apple-only) — [HN 40462472](https://news.ycombinator.com/item?id=40462472), [HN 40627821](https://news.ycombinator.com/item?id=40627821)
- Silos and "negative value": samstave (2025-02-19): earlier tools (MindMeister, Workflowy) "provided negative value" because they were disjointed; wants AI mind maps that output diagrams such as Mermaid and SVG. (ONE-OFF) — [HN 43097149](https://news.ycombinator.com/item?id=43097149)
- Text/diff-ability: creer (2025-01-13) criticises mind-map formats for lacking "linearity, diff-ability, text-ability." visarga (2026-06-30): "Plain old markdown with links is exactly what I use." (SOME, matches pass 1) — [HN 42686639](https://news.ycombinator.com/item?id=42686639), [HN 48728524](https://news.ycombinator.com/item?id=48728524)
- Local-first/privacy wishes, 2026 (SOME): c_hastings (2026-08-10) wants a tool to "turn it into a knowledge graph/mind map without sending everything over the cloud." Cygtree (2026-09-08), describing their own app: "The AI is fully local" and "I dont sell credits, AI usuage or anything of the like." ppnpm (2026-08-10) on their own product: "It has completely local environment and has no servers." — [HN 49238463](https://news.ycombinator.com/item?id=49238463), [HN 49608906](https://news.ycombinator.com/item?id=49608906), [HN 49239884](https://news.ycombinator.com/item?id=49239884)
- Skeptics: __warlord__ (2023-01-12) "Taking notes and mind-maps have not worked for me"; timrichard (2017-11-04) "it's much quicker with Markdown and bullet points"; sputr (2022-01-27) "I really need to find a better note-taking that does not try to do a fancy 'mind map'." solardev (2024-04-16) says such apps "shoehorn information into Sherlock-like 'mind palaces'" that make it harder to find things later. (SOME) — [HN 34351056](https://news.ycombinator.com/item?id=34351056), [HN 15626797](https://news.ycombinator.com/item?id=15626797), [HN 30098850](https://news.ycombinator.com/item?id=30098850), [HN 40047083](https://news.ycombinator.com/item?id=40047083)
- Positive on digital: _y5hn (2020-06-07): "mindmaps works best digitally in my personal experience, both for memorization and reference." (ONE-OFF, counters the memory-sport view) — [HN 23446173](https://news.ycombinator.com/item?id=23446173)
- Subscription: rcarmo (2023-02-28) avoids subscriptions "unless they are absolutely necessary or unique (like XMind)", i.e. at that time Xmind was an accepted exception. HN comments in general show a split on subscriptions (some "don't mind", some object); no HN comment found specifically complaining about Xmind or MindNode pricing. — [HN 34966714](https://news.ycombinator.com/item?id=34966714)
- MindNode subscription complaints (snippet only, from search summary of Capterra/Reddit): a reviewer said the update "gutted the version I bought"; a Capterra reviewer would buy "with my eyes closed if it wasn't a subscription" and wants a lifetime licence. Pricing figures conflict across aggregators ($2.99/month on one, $24.99/year on another). (SOME, unverified quotes) — [Capterra MindNode](https://www.capterra.com/p/207384/MindNode/), [Toolradar](https://toolradar.com/tools/mindnode)
- Xmind (snippet only): Trustpilot AU 2.4 stars from 7 reviews, top complaint an unexpected $99 annual charge dated 2025-10-17; Capterra (updated Jan 2026) reviewers object to subscription on a desktop app and restricted upgrades; G2 summary says users find it expensive with limited export without upgrade, AI limitations a smaller theme. Tiny samples. (SOME) — [Trustpilot AU](https://au.trustpilot.com/review/xmind.net), [Capterra Xmind](https://www.capterra.com/p/128088/XMind/reviews/?page=2), [G2](https://www.g2.com/products/xmind/)
- Miro performance (snippet only): Miro's own help says boards slow with many users or lots of content; a community poster with ~250 frames/1,000+ objects said it is hard to change something "and not to break other frames"; others said auto-spacing could not make a compact mind map. (SOME) — [Miro community](https://community.miro.com/ask-the-community-45/big-mindmaps-and-auto-layout-1975), [Miro help](https://help.miro.com/hc/articles/360013588560)
- Crowded field: burnt-resistor (2024-11-22) says many wikis and mindmap apps "already exist with many of the same features". (ONE-OFF) — [HN 42215061](https://news.ycombinator.com/item?id=42215061)

### Inferences
- Differentiation cannot be "mind map app + AI"; the 2026 HN pattern is that this is already being built by many hobbyists. Visual output quality, local operation and open formats are the open ground.
- Subscription anger attaches to desktop apps that were previously bought; one-time purchase or an AI-credits-only paid tier fits the evidence.

### Gaps
- No readable "best mind mapping app" thread 2024-2026 with ranked recommendations; Reddit unreadable. No HN comments on Mapify or NotebookLM maps found in this pass. Review-site quotes are snippets.

## 2. Study communities: mind maps vs Anki vs picture mnemonics

### Takeaway
Independent student voices I could open were few. What exists says tool choice matters less than repeated retrieval; Anki is the default retention tool, Sketchy/Picmonic are picture-story supplements, and mind maps are for relationships. Almost all pro/anti comparison text is vendor-written.

### Cited Findings
- StudentDoctor thread (snippet): one poster says the specific tool does not matter versus repeated exposure ("brute force repetition, concept maps, anki, videos, or whatever, it doesn't matter"); another thread title "I hate Anki, am I crazy?" had a user preferring Picmonic over Sketchy+Anki ("Picmonic > Sketchy + Anki IMHO"). Pages could not be opened (403). (ONE-OFF each) — [SDN Anki or concept maps](https://forums.studentdoctor.net/threads/anki-spaced-repetition-or-concept-maps-in-medical-school.1114988), [SDN hate Anki](https://forums.studentdoctor.net/threads/i-hate-anki-am-i-crazy.1349771/)
- A medical-student essay on mind mapping (snippet) says without instruction maps can be "overly simplistic" or misrepresent complex relationships. — [Pathologist](https://thepathologist.com/outside-the-lab/power-study)
- Vendor-only criticism of Sketchy (snippet): Picmonic claims its scenes are simpler and "less overwhelming" and that Sketchy videos are longer; Picmonic marketing, treat as biased. Sketchy is also said to be weaker for conceptual subjects such as physiology (snippet, source not identified). — [Picmonic comparison](https://www.picmonic.com/pages/why-students-use-picmonic-sketchy/)
- Medical-school guidance via pass 1: images help anatomy, maps help context. No new independent evidence found on symbol overload.

### Inferences
- Treat generated node images as a memory scaffold for concrete, namable things, and keep relationship structure in the map itself, which matches how students split work between picture mnemonics and maps.

### Gaps
- No readable student account comparing time cost of building maps vs watching Sketchy. No Reddit r/medicalschool or r/Anki. Student praise/criticism of Sketchy symbol overload could not be sourced.

## 3. How Sketchy designs picture-mnemonic scenes (analogue for generated images)

### Takeaway
Sketchy's own description confirms the design rules: consistent recurring symbols, a recurring cast, a story, and a separate setting per unit. This is vendor material, not user evidence, but it is a usable design pattern.

### Cited Findings
- Recurring symbols: "we've brought back our recurring symbols from your favorite Sketchy sketches", which link different specialties. — [Sketchy blog](https://www.sketchy.com/blog/how-sketchy-neurology-dives-deep-into-the-sketchy-method-with-story-and-characters)
- Recurring cast ("a loveable creature from the deep, a fearless bird") and a story that orders complex material. Same source.
- Spatial separation: "each of the units takes place in a different setting within the broader story", i.e. one setting per topic so topics stay distinct. Same source.
- The page does not describe humour inside scenes; humour/absurdity claims for Sketchy/Picmonic are not sourced here.
- Univ. tech page (snippet) says the videos start from a blank canvas that fills as the narrator explains symbols, with symbols used consistently. — [WSU](https://tech.medicine.wsu.edu/technology/sketchy-medical/)

### Inferences
- Style-preset rules: a fixed symbol dictionary per map (same concept type, same motif), one "setting"/palette per main branch, a recurring mascot per map, and reveal-in-order building of a scene.

### Gaps
- No independent critique of symbol overload; no data on how long students take.

## 4. Sketchnotes and visual note-taking

### Takeaway
Rohde's core stance is "Ideas, not art"; sketchnotes are for the note-taker first. Layout vocabulary (radial, path, popcorn etc.) is documented, but I could not open the book or Rohde's own pages, so the seven-pattern list rests on secondary pages.

### Cited Findings
- "Ideas, Not Art" and five basic shapes (circles, squares, triangles, dots, lines): Rohde "emphasizes how it's not about making art, but about capturing ideas using our verbal and visual senses simultaneously" per a reviewer, who adds the combination "leads to increased retention years later" (reviewer's claim). — [David Seah review](https://davidseah.com/2012/12/review-the-sketchnote-handbook-by-mike-rohde/)
- Rohde quoted (snippet) that "art... carries baggage"; "Sketchnotes are for you first, then for others." — [Big Draw](https://thebigdraw.org/5-keys-to-better-sketchnoting)
- Layouts (secondary): radial = "a central element and then spokes coming out from the centre"; path shows progression in "a giant U, a zig-zag, a spiral"; popcorn = "random chunks of information across the page"; a key image can be "a container for the rest of the sketchnote"; flowchart shapes linked "with arrows or lines that take the reader on a journey". This page names path, radial, columns, grid, popcorn, not Rohde's exact seven names. — [Sketchy Ideas layouts guide](http://sketchyideas.co/sketchnote-layouts-the-ultimate-guide/)
- Search summary lists the seven Rohde layouts (linear, radial, vertical, path, modular, skyscraper, popcorn) with radial/popcorn suiting a centred title — snippet, not verified against the book.
- Sunni Brown, Dan Roam: not retrieved.

### Inferences
- A style system should offer layout archetypes beyond radial (path/timeline, columns, grid/modular, popcorn) and treat container shapes and connectors as first-class styles.

### Gaps
- Rohde's primary text on typography/containers/connectors/icons not read. No practitioner data on what makes sketchnotes memorable beyond the reviewer's claim.

## 5. Hand-drawn vs digital; iPad and Pencil

### Takeaway
Thin and mostly secondary. The one forum thread (snippet) says no mind-map app uses the Pencil well. Roundups split the market into canvas tools (Freeform, Concepts) with ink but no structure, and structured apps (MindNode) with Pencil support.

### Cited Findings
- Mac Power Users thread (snippet; page 404 on fetch): one commenter says there is "no real mind mapping app that has satisfactorily made use of the Pencil"; another chose Concepts; a third found iThoughts closest to hand-drawn maps because users can draw on topics. (SOME) — [MPU forum](https://talk.macpowerusers.com/t/anyone-have-suggestions-for-a-mind-mapping-ios-app-that-utilises-the-apple-pencil/14659)
- Roundups (snippet): Freeform has the best free ink but "no structure"; Concepts is vector, pressure/tilt, but no Files integration (MacStories); GoodNotes canvas is a single sheet; MindNode is Pencil-native with structure. Auto-layout, collapse and outline view are what separate a mind map from a drawing. Vendor/blog roundups. — [Storyflow](https://storyflow.so/blog/best-mind-mapping-apps-ipad-2026), [Paperlike](https://paperlike.com/blogs/paperlikers-insights/ipad-for-brainstorming)
- A 2025 study (snippet) on Japanese kanji: AI mnemonic illustrations did not clearly improve short-term recall but reduced cognitive load; included a hand-drawing condition. — [EJMSTE/ICCE results via search](https://library.apsce.net/index.php/ICCE/article/download/5624/5556/6796)

### Inferences
- Gap in market: structured map plus real vector ink (draw on or over nodes, ink converted to editable strokes).

### Gaps
- No first-person user reviews of Pencil mind mapping (App Store reviews unreadable).

## 6. What makes admired mind maps look good

### Takeaway
All readable guidance traces to Buzan's laws; the concrete visual rules are consistent across Paul Foreman's own walkthrough, IQ Matrix and Xmind's design article. No championship rubric with points was found.

### Cited Findings
- Foreman (own slides): start with "a central image that best represents the subject"; work in pencil first; main branches "no more than 11" for memory; single keywords because "a phrase can stop the train of thought"; "concentrating on simplicity" for sketches; colour each branch differently, "light colours" spread evenly; branches thick near centre, thinner outward; "curved rather than straight-lined... organic and flowing". — [Foreman, Drawing a Mind Map](https://www.slideshare.net/slideshow/drawing-a-mind-map-from-start-to-finish/3174107) (COMMON, repeated everywhere)
- IQ Matrix: different colour per main branch; taper lines; vary branch thickness and endings; "Vary word sizes to show importance"; upper/lower case to signal importance; vary fonts; borders/boundaries around branches; "proper spacing between topics"; multi-headed arrows; images used literally or as metaphor/sound; at least four thick organic branches. Rules "optional". — [IQ Matrix](https://blog.iqmatrix.com/how-to-mind-map)
- Xmind design article (software vendor): "always go with low-saturation colors" if unsure; "Once settled, keep it across the entire sheet"; avoid reusing a colour for unrelated branches; align elements; "select images with a similar style to achieve design unity"; text-size contrast must be big enough for hierarchy; mix structures for complex logic; says nothing on whitespace. — [Xmind](https://xmind.com/blog/beautiful-mind-maps)
- Buzan laws (secondary snippet): picture at the centre, at least three colours, curves not straight lines, one keyword per line, images throughout. — [Nottingham](https://www.nottingham.ac.uk/helmopen/rlos/study-skills/critical-reflection/other_methods/mindmaps_steps.html)
- Judging: UTAR's 2024 competition requires Buzan laws and "visually attractive" maps (snippet; PDF unreadable). A Marek Kasperski book listing claims 23 official criteria (structure, clarity, creativity, imagery, colour, impact) — sales text, unverified. A medical-education rubric (BMC 2009) scores hierarchy, cross-links, pictures, colour (snippet; table unreadable). No official World Mind Mapping Championship marking scheme found. — [Kasperski listing](https://books.by/professor-marek-kasperski/how-to-become-a-mind-map-cha), [BMC rubric](https://bmcmededuc.biomedcentral.com/articles/10.1186/1472-6920-9-19)
- Genovese (Learning Fundamentals): hand-drawn method, "You do not need to be able to draw" (course page, snippet). Boukobza, Thum, Garcia, Buskes, Biggerplate gallery commentary: not retrieved. — [Let's Mind Map](https://learning-fundamentals.teachable.com/p/lets-mind-map)

### Inferences
- Rules that disagree: Foreman wants light colours; Xmind wants low saturation; Buzan wants vivid. Offer presets rather than one rule. Whitespace is under-documented; set it from own judgment and test.

### Gaps
- No analysis of specific admired maps; no judge-voiced rubric.

## 7. Educators' positions (primary sources largely not obtained)

### Takeaway
I could not get Justin Sung's own text; his GRINDE expansion is NOT verified. Zettelkasten forum gives a usable relation between maps and structure notes.

### Cited Findings
- GRINDE: sources disagree on letters (one summary: Grouping, Relational, Interconnected, Nonverbal, Directional, Emphasized; another has G, R, I as Grouped, Reflective, Interconnected). "Emphasized" is consistent. All are third-party or AI summaries; not authoritative. Sung video "The Ultimate Guide to The Perfect Mindmap (6-Step Checklist)", July 2024 (per search). One summary: emphasis makes a "backbone"; "if everything is important, nothing is". — [Flowershow](https://my.flowershow.app/@KruznickMeta/dg_flowershow/GRINDE+Mind+Mapping+Framework), [VideoHighlight](https://videohighlight.com/v/5zT_2aBP6vM)
- Zettelkasten forum thread, March 2021: Will calls a mind map "a 3D structure note" and says giving it structure-note detail would be "huge and cumbersome"; henrikenggaard uses maps for high-level view of notes; GeoEng51 argues the relationship "can be much more complex and more integrated." Snippet: structure notes are "control panels"/entry points. (SOME) — [Zettelkasten forum](https://forum.zettelkasten.de/discussion/comment/10955)
- Biggerplate: 2014-2017 annual reports (700-1,100+ respondents) exist but are behind login; I could not read results. Chuck Frey's 2025 trends page (via fetch summary): productivity gains "~35%", "Improved understanding remains the top benefit", "Knowledge management becomes the leading application", AI used "mainly for expanding content, exploring perspectives, and summarisation"; panel disagrees on AI value. No market share or sample size obtained. A January 2026 member survey was open; results not found. — [Biggerplate 2025 trends](https://www.biggerplate.com/Videos/View.aspx?id=759), [Biggerplate 2026 survey](https://www.biggerplate.com/articles/View.aspx?id=11)

### Gaps
- Cal Newport, Thomas Frank, Ali Abdaal (no stated view found in pass 1), Oakley, Forte, Sunni Brown, Dan Roam: not obtained.

## 8. Neurodiversity (first-person)

### Takeaway
A few first-person accounts exist; benefits are chunking, getting ideas out of the head, and choice of words or drawings. Overwhelm is not discussed in what I could read.

### Cited Findings
- Dyslexic blogger (2016): mind mapping helps "to break the subject or topic down into small bites" and "brainstorm and put our ideas on to paper"; has "the flexibility to choose weather to write or draw"; "I know mind mapping is not for everyone". (ONE-OFF) — [Dyslexia FTW blog](https://dyslexiaftw.blogspot.com/2016/10/mind-mapping-and-dyslexia.html)
- CHADD Attention magazine Oct 2024: first-person adult-ADHD piece under a pseudonym calls mind mapping transformative; the piece notes little research on efficacy (snippet; page failed to load). — [CHADD](https://chadd.org/attention-article/from-chaos-to-clarity-using-mind-maps-to-navigate-adult-adhd/)
- Also seen as snippets: FE News dyslexia piece, Ayoa case study (vendor), Dyslexia Explored podcast Sept 2025. Not read.

### Gaps
- What overwhelms (dense maps, colour overload, drag-and-drop) is unsourced here.

## 9. AI-generated images in study material

### Takeaway
Evidence is small; main criticisms are artifacts, inconsistency across regenerations and stereotyped defaults. No data found on "generic look".

### Cited Findings
- Jisc pilot (2025-05-15): "AI-generated images often included inaccurate or inconsistent elements" ("extra fingers, twisted limbs, impossible shadows"), some "unusable in a formal context"; "the more they iterated an image, the more distorted it became" (since improved by GPT-4o per Jisc); text in images weak; defaults "Western-centric, stereotypical imagery"; "Sometimes stock images can be just as good." — [Jisc](https://nationalcentreforai.jiscinvolve.org/wp/2025/05/15/guidance-on-ai-image-generation-learnings-from-our-pilot/)
- Kanji study (snippet, see section 5): illustrations lowered cognitive load but did not clearly raise recall.

### Inferences
- Avoid in-image text (render labels as SVG/text layers); use one fixed style prompt/seed/palette per map; flat vector or line art reduces uncanny artifacts; keep humans out or stylised.

### Gaps
- No user-voice on AI illustrations in notes; "slop" reaction unsourced.

## 10. Updated ranked needs (merged with pass 1)

1. Stable, controllable layout and graph-capable cross-links, not tree-only (COMMON, pass 1; Miro auto-spacing complaints, pass 2 snippet).
2. Keyboard-first flow with synced outline view (COMMON, pass 1).
3. Open plain-text storage and strong vector export (COMMON; reinforced 2025-26: creer, visarga).
4. Scale: collapse, linked sub-maps, density; large boards slow (COMMON).
5. AI scaffolds but user builds; editable output; gap-check and quiz (COMMON in critiques).
6. Local/offline operation and local AI, no cloud upload (SOME, rising in 2026 HN: c_hastings, Cygtree, ppnpm).
7. Fair pricing, no subscription on a desktop app, no hidden charges (SOME: Xmind/MindNode review snippets).
8. Retrieval support: hide/reveal, self-test (SOME).
9. Memorability through images, colour, hand-drawn feel (SOME; strongest in memory/sketchnote communities; independent evidence thin).
10. Pen/ink input on structured maps (SOME-ONE-OFF, MPU snippet).
11. Reuse of nodes in multiple places (ONE-OFF).
12. Visual consistency of generated imagery without artifacts or text (inferred from Jisc and design guides; no direct user demand found).

## 11. Visual traits checklist (for style presets and AI art direction)

Sourced = in Foreman, IQ Matrix, Xmind or Buzan summaries above. Judgment = my suggestion.
- [ ] Central image: single, simple, representative, largest element (sourced).
- [ ] Main branches: 5-9 (some say up to 11) thick, curved, organic; taper from thick to thin outward (sourced).
- [ ] One colour per main branch; same colour family down the branch; do not reuse colours across unrelated branches (sourced). Palette presets: vivid (Buzan), light (Foreman), low-saturation (Xmind). Keep consistent across the sheet.
- [ ] One keyword per line, text sitting on the branch line (sourced); size/case hierarchy with large enough contrast (sourced).
- [ ] Images where they help, not on every node; simple sketches, consistent style across the map (sourced). Images as literal, metaphor or sound-alike (sourced).
- [ ] Borders/clouds/containers to group a branch; varied shapes for segments (sourced).
- [ ] Cross-link arrows, multi-headed, distinct colour/style from branches (sourced).
- [ ] Spacing between topics (sourced); generous whitespace around the central image (judgment).
- [ ] Layout archetypes: radial, path/timeline, columns, grid, popcorn (sketchnote guide).
- [ ] Per-map symbol dictionary and per-branch "setting" (Sketchy pattern, judgment).
- [ ] No text inside generated images; labels as live text/SVG (Jisc, judgment).
- [ ] Neutral cast/avoid stereotyped defaults; fix style prompt per map (Jisc, judgment).
- [ ] Hand-drawn wobble/ink option for sketchnote preset (judgment, supported by Rohde "ideas, not art").
- [ ] Emphasis device: only a few nodes emphasised, rest quiet (GRINDE "Emphasized", unverified source).
