# Pass 2: multimedia learning and visual cognition for a picture-and-decoration mind-map app (as of Nov 2026)

Process note: about 35 tool calls, mostly search snippets. Only one page fetch gave content (and it was empty), so every number below is from search-result summaries, abstracts or secondary pages. Where a number comes from a slide deck or secondary page, I say so. Strength labels: strong = meta-analysis or multiply replicated; moderate = several studies or one review; weak = single study, abstract only, or conflicted; folklore = no support found. Pass 1 refers to `science_of_memorable_maps.md`.

## 1. Dual coding theory and the picture superiority effect

### Takeaway
Dual coding (Paivio) explains why pictures plus words can beat words alone. It is a broad but contested framework. Picture superiority is robust for recognition and for perceptually driven tasks. It shrinks or reverses when encoding or retrieval is conceptual, or when the pictures are highly similar to each other.

### Cited Findings
- Core claim: Paivio's theory holds that verbal and imagery systems are separate but linked. The best open overview is the Stanford Encyclopedia supplement, which says the theory "has by no means gained universal acceptance". [SEP dual coding](https://plato.stanford.edu/archives/spr2019/entries/mental-imagery/dual-coding-theory.html)
- Criticism 1: the propositional account (Anderson & Bower) says meaning is stored as propositions, not images, and is argued to be more parsimonious. [SEP](https://plato.stanford.edu/archives/spr2019/entries/mental-imagery/dual-coding-theory.html)
- Criticism 2: Kintsch (1977) and Flanagan (1984) argued that Paivio miscounted the codes, and that there would need to be one code per sense ("six-code theory"). [SEP](https://plato.stanford.edu/archives/spr2019/entries/mental-imagery/dual-coding-theory.html)
- I did not retrieve concreteness-effect numbers. The SEP page and search snippets did not give them. Strength of dual coding as an explanatory frame: moderate.
- Nelson's sensory-semantic model (1979): pictures and words share semantic codes, but pictures have more distinctive sensory codes, so pictures are better remembered. [Wikipedia picture superiority](https://Www.Wikipedia.org/wiki/Picture_superiority_effect)
- Boundary conditions:
  - Weldon & Roediger (1987): the effect can be eliminated or reversed by changing encoding demands. It is relatively insensitive to retrieval demands. [Wikipedia](https://Www.Wikipedia.org/wiki/Picture_superiority_effect)
  - Picture superiority can be eliminated or reversed depending on the conceptual encoding task and the conceptual retrieval test. [Typeset PDF](https://typeset.io/pdf/altering-retrieval-demands-reverses-the-picture-superiority-490p6wzfi6.pdf)
  - When similarity among pictures was high, no picture superiority was found in the experiments summarised. [Wikipedia](https://Www.Wikipedia.org/wiki/Picture_superiority_effect)
  - Stenberg (2003) reasoned that it would not survive a study-to-test switch where only semantic (not perceptual) features carry over, for example studying a horse picture and testing with the word "horse". [Wikipedia](https://Www.Wikipedia.org/wiki/Picture_superiority_effect)
- Older and impaired adults: a Wikipedia-derived page says the recognition effect becomes more pronounced with age. Ally, Gold & Budson (2009) reportedly found the effect in mild Alzheimer's disease and amnestic MCI. I did not verify either claim in a primary paper. [Wikipedia](https://Www.Wikipedia.org/wiki/Picture_superiority_effect). Weak.

### Inferences
- Image-per-node helps most when the learner later has to recognise a node or when the image cues the meaning perceptually. It helps less if the test is conceptual and the image is generic.
- When sibling nodes get near-identical pictures (same style, same composition), picture superiority may be lost. The similarity finding supports distinct, concept-specific images per sibling. This is an inference.
- Pictures must be paired with the label. The dual-coding account depends on both codes being available.

### Gaps
- Concreteness-effect effect sizes and the older-adult recall picture were not obtained. Primary papers are needed (Paivio 1971/1986; Ally et al. 2009).

## 2. Functions of pictures in text (Levin; Carney & Levin 2002)

### Takeaway
Levin's typology says the function of a picture, not its presence, predicts benefit. Decorational pictures are the category that does not help. I could not obtain the per-category effect sizes from Levin, Anglin & Carney (1987), so I cannot confirm the "decorational near 0, transformational largest" ranking with numbers.

### Cited Findings
- Carney & Levin (2002, Educational Psychology Review 14(1):5-26) reviewed 1970s-80s research and concluded that carefully constructed text illustrations generally improve performance on text-dependent cognitive outcomes. The five categories are representational, organizational, interpretational, transformational and decorative. [DOI record](https://www.doi.org/10.1023/A:1013176309260), [Missouri State record](https://bearworks.missouristate.edu/articles-chhs/956)
- Levin, Anglin & Carney (1987, in Willows & Houghton, The Psychology of Illustration, pp. 51-85) is the meta-analytic source. A secondary summary states that illustrations, except decorative ones, have consistently produced greater text learning. It also says effect sizes were much larger for adjunct pictures than for figural displays such as diagrams and maps. [e-teaching.org](https://www.e-teaching.org/materialien/literatur/levin_etal1987), [JALT summary](https://jalt-publications.org/sites/default/files/pdf-article/jalt2011-038.pdf). Moderate for the ranking; no numbers.
- Levin's 1981 typology had more roles (decoration, remuneration, motivation, reiteration, representation, organization, interpretation, transformation). Motivation was dropped in later versions. [JALT summary](https://jalt-publications.org/sites/default/files/pdf-article/jalt2011-038.pdf)
- A separate meta-analysis (Höffler & Leutner 2007) reported d = 0.40 for animation versus static pictures when the animation was representational rather than decorational. This is a different study from Levin's. [Höffler & Leutner PDF](https://wikicap.ulb.be/images/e/ef/Hoffler_Leutner_2007.pdf)

### Inferences
- Image types for this app, ranked by expected value: transformational (mnemonic recoding of abstract or hard-to-remember content into a memorable image; see section 3), interpretational (clarifies a hard concept), organisational (the map structure itself plays this role), representational (depicts what the text says), decorative (lowest).
- The image generator should choose the picture function per node. A node that is a concrete object gets a representational picture. A node that is an abstract term or a name gets a transformational mnemonic picture. Do not generate decorative filler.

### Gaps
- Per-category effect sizes from the 1987 chapter were not found. The chapter or Carney & Levin 2002 full text is needed. Do not quote "0" or "1.4" figures in the requirements.

## 3. Keyword and pictorial mnemonics; Picmonic and Sketchy

### Takeaway
Mnemonic picture methods produce large effects on arbitrary-association learning (vocabulary, names, facts), mostly in the originators' labs. Dunlosky (pass 1) rates the keyword mnemonic low utility because it is limited to keyword-friendly material. The only controlled study of a commercial medical picture-mnemonic product (Picmonic) is industry-linked. I found no controlled study of Sketchy.

### Cited Findings
- Atkinson & Raugh (1975): 120-word Russian vocabulary, keyword group scored 72% on the most critical test versus 46% for controls (from the 1974 technical report). A 1975 critique questioned whether this would hold in a between-subjects design where controls could devise their own strategies. [ONR technical report](https://apps.dtic.mil/sti/pdfs/AD0787843.pdf), [Scribd critique copy](https://www.scribd.com/document/291868639/345-1). Moderate for vocabulary.
- Mastropieri & Scruggs: one synthesis of 24 experimental studies, mainly with students with learning disabilities, reports an average effect size of about 1.62 SD for mnemonic instruction. A CEC alert notes that researcher-made measures tend to give larger effects than other measures, and that the keyword strategy is the most thoroughly researched of the mnemonics. I could not confirm the authorship of the 1.62 figure from the listing. [Bohrium listing](https://www.bohrium.com/paper-details/mnemonic-instruction-for-students-with-learning-disabilities-what-it-is-and-what-it-does/812107334636535809-5141), [CEC alert](https://exceptionalchildren.org/sites/default/files/2025-08/original_Alert5.pdf). Moderate, with a size caveat.
- Yang et al. (2014, Advances in Medical Education and Practice): single-centre, randomised, subject-blinded controlled study of 257 first-year osteopathic students, Picmonic versus text materials. Reported gains of 65%, 161% and 208% on immediate, 1-week and 1-month free recall (P<0.001). Several authors had a financial interest in Picmonic. [Dove Press](https://www.dovepress.com/the-picmonicreg-learning-system-enhancing-memory-retention-of-medical--peer-reviewed-article-AMEP), [Informa abstract](https://informahealthcare.com/doi/abs/10.2147/AMEP.S61875). Weak (conflict of interest, text-only control, percentages not effect sizes).
- A 2025 podiatry study of Picmonic was quasi-experimental, not randomised. [JMIR Med Educ 2025](https://mededu.jmir.org/2025/1/e55206/PDF). Weak.
- Sketchy: no randomised or controlled study found; only competitor marketing. [Picmonic page, promotional](https://picmonic.com/pages/?p=15467). Folklore on efficacy.

### Inferences
- Support for a "mnemonic picture" mode on abstract or arbitrary items (drug names, dates, foreign terms). It is not a general-purpose node-image mode.
- Limit claims: do not cite Picmonic percentages as proof.

### Gaps
- Levin's pictorial-mnemonic meta-analytic numbers and Mastropieri & Scruggs's primary meta-analysis were not retrieved.

## 4. Mayer's Cognitive Theory of Multimedia Learning

### Takeaway
Median effect sizes for the relevant principles are moderate to large, but come from short lab lessons, mostly with low-prior-knowledge learners. Treat them as direction, not forecasts.

### Cited Findings
- Mayer (2017, J. Computer Assisted Learning) abstract medians (as quoted by a search summary): multimedia d=1.67 (5 comparisons), coherence 0.70, signalling 0.46, redundancy 0.87, spatial contiguity 0.79, temporal contiguity 1.30, segmenting 0.70, pre-training 0.46, modality 0.72, personalization 0.79, voice 0.74, embodiment 0.36. Some principles are stronger for low-knowledge than high-knowledge learners. [Synapse listing of the 2017 abstract](https://synapsesocial.com/papers/W2625051696), [JCAL DOI listing](https://zendy.io/title/10.1111/jcal.12197)
- A later Mayer table reproduces coherence at median d=0.86 (18 of 19 tests positive) and segmenting at 0.67 (7 of 7). The two Mayer sources disagree for coherence and segmenting, so the numbers move with edition. [Mayer 2020 PDF](https://ugc.futurelearn.com/uploads/files/7d/d6/7dd6188d-c343-4311-b064-ac98d2c95abc/Multimedia_Principles._R._E._Mayer__2020.pdf)
- Generative activities (drawing d=0.40 median, summarising 0.50, learner-generated outlines and organisers 0.59-0.63): see pass 1 section 2 and [Springer 2025](https://link.springer.com/article/10.1007/s10648-025-10067-7).
- Stull & Mayer (2007, J. Educational Psychology 99:808-820) compared learner-generated and author-provided graphic organisers in three experiments. I could not retrieve its results. A later study (Colliot & Jamet) found that an author-provided organiser helped, while self-generating one versus viewing a ready-made one reduced retention of the covered material. [Bohrium summary](https://www.bohrium.com/paper-details/does-self-generating-a-graphic-organizer-while-reading-improve-students-learning/813015968925089794-9279). Weak and mixed. The newer Ponce, Mayer & Méndez meta-analysis (organisers: 0.59 memory, 0.63 comprehension) favours learner generation.
- Strength: moderate. These are medians of small sets, often from the author's own lab.

### Inferences
- Coherence: remove non-essential visuals. Signalling: highlight the branch the learner should attend to. Spatial contiguity: put the label touching or inside the image, not in a legend. Segmenting and pre-training: expand a map progressively; show the key terms before the details. Personalization: learner-voiced labels (conversational wording) are supported, as an extrapolation.

### Gaps
- Exact 3rd-edition table not retrieved. Mayer's own handbook text was not available.

## 5. Cognitive load theory (Sweller, Kalyuga)

### Takeaway
Richly illustrated maps risk extraneous load (split attention, redundancy), and expert users may be harmed by guidance that novices need (expertise reversal).

### Cited Findings
- Expertise reversal: instructional methods that help novices lose value or reverse as knowledge grows (Kalyuga 2007). Chen, Kalyuga & Sweller (2017) argue it is a variant of the broader element-interactivity effect. [Kalyuga 2007 PDF](https://www.uky.edu/~gmswan3/EDC608/Kalyuga2007_Article_ExpertiseReversalEffectAndItsI.pdf), [Loughborough record](https://repository.lboro.ac.uk/articles/The_expertise_reversal_effect_is_a_variant_of_the_more_general_element_interactivity_effect/12052695)
- A 2025 meta-analysis of the expertise reversal effect (Tetzlaff, Simonsmeier, Peters & Brod, Learning and Instruction) reportedly covers 176 effect sizes from 60 experiments (N=5,924), with educational status and domain as moderators. I saw only a secondary summary and no pooled value. [Wikipedia pointer](https://en.wikipedia.org/wiki/Expertise_reversal_effect). Moderate, unverified.
- Mayer's medians for redundancy (0.87) and spatial contiguity (0.79) in section 4 are the closest numbers I obtained for split attention and redundancy.
- Split-attention and redundancy meta-analytic numbers (Chen et al. 2018) were not found.

### Inferences
- Make images, colours and decoration switchable per user. Novices get the full scaffold; experts get a "lean" view with images collapsed. Default to lean when the user is reviewing material they have marked as known.
- Do not repeat the same information in the label, a caption and the image (redundancy).

### Gaps
- Sweller's primary papers and the exact effect-size tables were not retrieved.

## 6. Seductive details and emotional design

### Takeaway
Both findings can hold. Seductive details are interesting but irrelevant additions (stories, photos) that slightly hurt learning. Emotional design alters the core visuals themselves (appealing colours, friendly faces), and the meta-analysis found small to moderate gains. The difference is whether the visual is irrelevant material added on top or the learning material designed to feel good.

### Cited Findings
- Sundararajan & Adesope (2020, Educational Psychology Review 32:707-734), "Keep it coherent": learners given seductive details scored lower. Press coverage cites 58 studies and over 7,500 students; a blog cites 68 experiments, so the count is conflicted. The authors call the effect fairly small. Harm was considerable in short lessons (under 5 minutes), not significant in longer ones (over 10 minutes) and larger for novices (blog summary). Format, timing, size, placement and frequency did not moderate. I could not retrieve the pooled g. [WSU news](https://news.wsu.edu/2020/03/19/seductive-details-inhibit-learning/), [Learning and the Brain](https://www.learningandthebrain.com/blog/seductive-details-when-do-cool-stories-and-videos-interfere-with-learning/), [e-teaching.org](https://www.e-teaching.org/materialien/literatur/sundararajan-adesope-2020). Moderate.
- Um, Plass, Hayward & Homer (2012, J. Educational Psychology 104:485-498): immunisation lesson; positive emotional design (appealing graphics with human-like features, distinct appealing colours) induced positive emotion and improved learning. Sources disagree on whether comprehension improved or only transfer. I found no confirmation of "warm colours" or "round shapes" in the abstract. [Record](https://bvbvf1.bib-bvb.de/vufind/PrimoRecord/cdi_proquest_journals_912256806), [Educ Tech J review](https://educationaltechnologyjournal.springeropen.com/articles/10.1186/s41239-020-00198-y). Weak.
- Brom, Stárková & D'Mello (2018, Educational Research Review): 33 independent samples (N=2,924); retention d+ = 0.387 (18 comparisons, slide deck gives CI [0.18, 0.60]); comprehension d+ = 0.317 (14 comparisons); transfer d about 0.33 (CI [0.20, 0.45], from slides). Conclusion: anthropomorphisms and pleasant colours appear useful. Numbers are from the abstract and slides. [Brom & Hannemann slides](https://ksvi.mff.cuni.cz/amulab/wp-content/uploads/2018/11/MultimLn2_BromHannemann_181018.pdf), [Brom manuscript](https://artemis.ms.mff.cuni.cz/main/papers/emodesign_manuscript_1rev_180928_FINAL_norev.pdf). Moderate. A 2024 meta-analysis on facial anthropomorphism alone exists. [Springer 2024](https://link.springer.com/article/10.1186/s40561-024-00332-7)

### Inferences
- Reconciliation: spend the aesthetic budget on the core objects (node shapes, branch colours, friendly faces on concept icons), and not on additional unrelated art around the map.
- Branch decoration that does not encode meaning is the highest-risk category. Short sessions and novices amplify harm.

### Gaps
- Sundararajan pooled g and the Um 2012 effect sizes were not found.

## 7. Signalling and colour cueing

### Takeaway
Cueing reliably helps retention and somewhat transfer. Colour coding works as a cue only when it carries information and is consistent.

### Cited Findings
- Alpizar, Adesope & Wong (2020, ETR&D 68:2095-2119): 44 effect sizes, 29 studies, N=2,726; overall d=0.38, moderated by study, participant, presentation and methodological features. [WSU record](https://rex.libraries.wsu.edu/esploro/outputs/journalArticle/A-meta-analysis-of-signaling-principle-in/99900601052901842). Strong.
- Schneider, Beege, Nebel & Rey (2018, Educational Research Review 23:1-24): per a secondary summary, 103 studies, N=12,201; retention g+=0.53, transfer g+=0.33. Prior knowledge and pacing are named as moderators. The figures differ across sources and I did not read the paper. [TUM Clearinghouse](https://www.clearinghouse.edu.tum.de/wp-content/uploads/2018/12/CHU_KR-22_-Schneider_2017_Lernmaterial_Hervorhebungen.pdf), [Springer 2020 citing paper](https://link.springer.com/article/10.1007/s10339-020-01002-5). Strong in direction; numbers unverified.
- Richter, Scheiter & Eitel (2016, ERR 17:19-36): 27 studies, 45 comparisons, N=2,464; r=0.17 (95% CI .11-.22) on transfer and comprehension; low prior knowledge learners benefited more. [PsychArchives data](https://psycharchives.org/handle/20.500.12034/2019), [Bohrium](https://www.bohrium.com/paper-details/signaling-text-picture-relations-in-multimedia-learning-a-comprehensive-meta-analysis/814569585163370497-11949). Strong.
- Colour-coding specifics (all weak): Skulmowski (2022, as cited in a 2024 review) reported that colour coding helped when used in both learning and retrieval but hurt when used in only one phase. In a physics class survey only about 16% of responses recognised and valued the colour coding unless it was explained. Hall & Sidio-Hall (1994): knowledge-map study recalled more than text, and self colour-coding interacted marginally (p=.08) with test anxiety. [Springer 2024](https://link.springer.com/10.1007/s10639-024-12460-1), [arXiv 2411.14605](https://arxiv.org/pdf/2411.14605), [Missouri S&T](https://scholarsmine.mst.edu/bio_inftec_facwork/468).
- Colour-blind-safe design: I found no study. Recommendation is a design inference only.

### Inferences
- Use colour hue as a category cue and explain the colour key once. Keep colour use the same across study and recall modes (the Skulmowski finding, weak).
- Add a second cue (icon, position, line style) so colour-blind users are not dependent on hue.

### Gaps
- No quantitative colour-coded study materials with effect sizes; no colour-blind evidence.

## 8. Emotion, humour, arousal

### Takeaway
Arousal and emotion can enhance memory for the emotional item, but the benefit is focal and has limits. I found no source on the humour effect and none on whether funny or exaggerated node images are supported.

### Cited Findings
- Kensinger (2004, 2009): arousal is a critical factor and boosts memory for central details. Enhancement also occurs for valenced, non-arousing items, via different, more controlled processes. [Kensinger 2004 PDF](https://bccanlab.squarespace.com/s/Kensinger_RevNeurosci04.pdf), [Emotion Review 2009 listing](https://www.nmr.mgh.harvard.edu/publications/journal_articles/1230)
- A 2013 short review says emotion does not always help, and that arousal helps up to a point and then hurts. [Cambridge JINS](https://www.cambridge.org/core/product/0ECD81D53D6DF52F741E2D1E48C5DC84). Moderate.
- Schmidt (1994) humour effect: not retrieved. Strength: unknown from my sources.

### Inferences
- Emotional images should be used sparingly on key nodes only (consistent with pass 1's isolation/bizarreness finding). Funny imagery is an untested hypothesis here.

### Gaps
- Schmidt 1994 and humour-in-learning studies.

## 9. Aesthetics, fluency, disfluency

### Takeaway
Beautiful interfaces are rated as more usable. That is a perception effect with weak evidence for actual performance gains. Making text harder to read to boost memory (disfluency) failed to replicate.

### Cited Findings
- Kurosu & Kashimura (1995): 26 ATM interface variants rated by 252 participants; apparent usability correlated strongly with beauty. Participants had not used the products. Tractinsky replicated in Israel. Tractinsky et al. (2000) found the same effect after use. A later boundary-conditions study found no effect of aesthetics on SUS ratings. A review says causation is not firmly established. [UXPA article](https://uxpajournal.org/?p=4392), [Tractinsky at BGU](https://www.bgu.ac.il/en/researcher/noam-tractinsky/publications/137131249/), [Monk & Lelos PDF](https://www-users.york.ac.uk/~am1/HOIT07MonkLelos.pdf). Moderate for perception; weak for performance.
- Processing fluency (Reber, Schwarz & Winkielman 2004): I did not retrieve a source. Not asserted.
- Disfluency: Diemand-Yauman et al. (2011) claimed hard fonts help. Three close replications by Rummer et al. (2016) failed, as did Eitel et al. 2014 and others. Xie et al. (2018) meta-analysis: 39 experiments, 25 articles, N=3,135, d=0.01. Weissgerber et al. (2021) questioned the meta-analysis's coding. A 2023 preregistered replication (N=96) found no disfluency effect. The original authors suggested distinctiveness as the alternative explanation. [Weissgerber critique PDF](https://wp.hse.ru/data/2021/11/10/1458461373/127PSY2021.pdf), [Springer 2023](https://link.springer.com/10.1007/s11409-023-09366-7), [PMC9733772](https://pmc.ncbi.nlm.nih.gov/articles/PMC9733772). Strong that the effect is absent or negligible.

### Inferences
- Beauty is justified for adoption and engagement, not as a memory mechanism. Do not use deliberately hard-to-read fonts or styles as a memory aid.
- Readable type and good contrast are the safe default.

### Gaps
- Reber et al. 2004 and the fluency literature.

## 10. Retrieval-based mapping (Karpicke & Blunt follow-ups)

### Takeaway
Concept mapping from memory works about as well as retrieval by writing a paragraph. Mapping with the source open is not effective. So the best combination is map-from-memory.

### Cited Findings
- Blunt & Karpicke (2014, J. Educational Psychology 106:849-858): students retrieved from a science text using either a paragraph or a concept map, with text present or absent. Concept mapping and paragraph writing were equally effective as retrieval activities. Mapping with the text present was not especially effective. [Blunt 2014 PDF](https://andymatuschak.org/prompts/Blunt2014.pdf), [Learning Scientists](https://learningscientists.org/blog/2020/11/19-1)
- Ortega-Tudela, Lechuga & Gómez-Ariza (2019) conceptually replicated the core result. [Univ. Jaen record](https://rujapre.ujaen.es/items/b958875d-d121-402a-a8cf-ea40e4630b96/full). Moderate.
- Mintzes et al. comment and O'Day & Karpicke 2021: not retrieved.

### Inferences
- The map-from-memory mode is justified. A map is a good retrieval format but no better than prose, so make the retrieval a feature and not the map format.

### Gaps
- The Mintzes comment and O'Day & Karpicke 2021.

## 11. Self-testing with maps: fill-in, skeleton, scaffold fading

### Takeaway
No new sources beyond pass 1. Pass 1 covers Chang et al. 2002 and Ruiz-Primo 2001. Stull & Mayer 2007 is treated in section 4.

### Cited Findings
- Colliot & Jamet: self-generating an organiser versus viewing a ready-made one reduced retention of covered material. Ponce, Mayer & Méndez 2025: learner-generated organisers 0.59 and 0.63. These two conflict, which suggests that generation helps when the learner is capable and supported. [Bohrium summary](https://www.bohrium.com/paper-details/does-self-generating-a-graphic-organizer-while-reading-improve-students-learning/813015968925089794-9279), [Springer 2025](https://link.springer.com/article/10.1007/s10648-025-10067-7). Moderate, conflicted.

### Inferences
- Support partly-blank maps and fade scaffolds with mastery. Novices see more provided structure.

### Gaps
- Chang et al. effect sizes; Stull & Mayer results.

## 12. AI-generated study materials (2023-2026)

### Takeaway
There is no controlled study that I found on AI-generated mind maps and learning. The nearest evidence suggests AI assistance raises performance during use, and unguarded use can hurt later independent performance.

### Cited Findings
- Bastani et al. (PNAS 2025, 122(26) e2422633122): field experiment with nearly 1,000 high school maths students. Practice performance rose 48% (GPT Base) and 127% (GPT Tutor). After access was removed, GPT Base students did worse than controls (one preprint version: 17% lower), while the guarded GPT Tutor largely removed the harm. Single school, maths only. [PNAS record via IDEAS](https://ideas.repec.org/a/nas/journl/v122y2025pe2422633122.html), [Wharton](https://knowledge.wharton.upenn.edu/article/without-guardrails-generative-ai-can-harm-education), [PsyPost](https://www.psypost.org/unrestricted-generative-ai-harms-high-school-math-learning-by-acting-as-a-crutch/). Moderate.
- Middlebury randomised study (IZA DP 18792): 211 undergraduates writing essays with or without AI; AI group scored 6.7 percentage points higher on the immediate test and 5.1 points higher a week later. Text-based, not images. [IZA PDF](https://docs.iza.org/dp18792.pdf). Weak-moderate (preprint).
- Medical mnemonic images: a 2025 preprint of 275 first-year medical students used DALL-E 3 ECG mnemonic images; a non-randomised comparison reported improved retention and higher situational interest. [Preprints.org](https://www.preprints.org/manuscript/202503.2153). Weak.
- RetAssist (arXiv 2024): within-subject study, 24 ESL learners, generative images versus none for vocabulary retelling. Results not retrieved. [arXiv](https://arxiv.org/pdf/2405.14794). Weak.
- A critique of a 40-participant text versus text-plus-AI-image study notes it lacked a traditional-image condition, so the AI-image advantage cannot be attributed to AI generation. Same search summary. Weak.

### Inferences
- Make the learner do the effortful step (edit, rebuild from memory, quiz) after AI generates. The guardrail result (GPT Tutor) is the closest evidence for that.
- No evidence that AI-generated images differ from other pictures in learning.

### Gaps
- No study found on cognitive offloading with AI-generated maps; no controlled AI-mind-map experiment.

## 13. Zoomable UIs, overview+detail, spatial memory

### Takeaway
Spatial layout supports retrieval when it stays stable. Animation helps users keep their mental map. Good tree browsers add previews and fit-to-screen behaviour.

### Cited Findings
- Cockburn, Karlson & Bederson (2008, ACM Computing Surveys 41(1)) classify interfaces as overview+detail (spatial separation), zooming (temporal separation), focus+context (integrated) and cue-based. I only retrieved the abstract. [Microsoft Research PDF](https://www.microsoft.com/en-us/research/wp-content/uploads/2008/01/cockburn-ComputingSurveys09.pdf)
- Scarr, Cockburn & Gutwin (Foundations and Trends in HCI 6(1):1-84): argues that interfaces should support the development of spatial memory and exploit it. [Dblp](https://dblp.dagstuhl.de/rec/journals/fthci/ScarrCG13.html). Robertson et al.'s Data Mountain found reliable advantages over IE Favorites. A later paper summarises that spatial layouts supported faster retrieval even after three months. [Microsoft Research Data Mountain](https://www.microsoft.com/en-us/research/?p=145460), [Graphics Interface 2020](https://graphicsinterface.org/wp-content/uploads/gi2020-22.pdf). Moderate.
- SpaceTree (Plaisant, Grosjean & Bederson 2002) uses dynamic rescaling, optimised camera motion and preview icons for unexpanded branches. A controlled experiment found benefits for returning to previously visited nodes and estimating tree topology. [UMD technical report](https://drum.lib.umd.edu/handle/1903/1197), [HCIL](https://hcil.umd.edu/?p=10092). Moderate.
- Bederson & Boltman (1999): animating a viewpoint change improved users' ability to reconstruct the information space, with no cost in task time. [UMD DRUM](https://drum.lib.umd.edu/items/3e73909e-a99d-4834-9f65-2869c47c8893/full). Moderate (one study, ZUI context).
- Heer & Robertson (2007): two controlled experiments found that animated transitions between statistical graphics significantly improve graphical perception (object tracking and value estimation). I could not verify the "staging" wording. [UW IDL](https://idl.uw.edu/papers/animated-transitions), [PDF](https://homes.cs.washington.edu/~jheer/files/2007-AnimatedTrans-InfoVis.pdf). Moderate.
- Card & Nation 2002 degree-of-interest trees, Furnas fisheye, Pad++: not retrieved.

### Inferences
- Keep positions stable across sessions, animate expand and collapse and re-layouts (short, to keep object constancy), keep a minimap, and preview collapsed branches (child count or icons).
- Spatial-memory benefits are shown for documents and icons, not for mind-map nodes. Extrapolation.

### Gaps
- Primary data on Cockburn's guidelines; Card & Nation; Pad++.

## 14. Mind-mapping meta-analyses 2020-2026

### Takeaway
I still could not obtain Shi et al.'s pooled effect size.

### Cited Findings
- Shi et al. (Asia Pacific Education Review, DOI 10.1007/s12564-022-09746-9; pass 1 lists the issue year as 2023): 21 studies, mind-mapping instruction versus traditional instruction. Subject matter and education level moderate the effect: lower-grade and STEM students gained more. No pooled g retrieved. The AMiner fetch returned no content. [DOI](https://www.doi.org/10.1007/s12564-022-09746-9), [AMiner](https://www.aminer.org/pub/628d1aab5aee126c0f386f37/effects-of-mind-mapping-based-instruction-on-student-cognitive-learning-outcomes-a)
- Other 2020-2026 mind-map meta-analyses with numbers: none found. Candidate leads from search results, not read: [Frontiers 2025 systematic review](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2025.1658797/full) and [Springer 2025, s40862-025-00331-2](https://link.springer.com/article/10.1186/s40862-025-00331-2).

### Inferences
- Do not quote a pooled effect in the requirements.

### Gaps
- Pooled g, CI, heterogeneity, and nursing or EFL-writing meta-analyses.

## 15. Design rule, evidence, strength (both passes)

### Takeaway
The rules the evidence supports best are generative construction, retrieval, spacing, cueing, and meaningful (not decorative) images. Aesthetic, curved, and "memory-friendly" colour claims are mostly preference or folklore.

### Cited Findings (table; sources are in the sections cited)

| Design rule | Evidence | Strength |
|---|---|---|
| Let the learner build or edit the map, not just view it | Creating g=0.72 vs studying 0.43 (pass 1 s2); generative organisers 0.59-0.63 (s4, s11) | strong |
| Include retrieval modes (hide, recall, reveal; map from memory) | Karpicke & Blunt 2011, Blunt & Karpicke 2014 equal to paragraph retrieval (s10; pass 1 s3) | strong |
| Spaced review per branch | Cepeda 2008 (pass 1 s3) | strong |
| Do not claim "mind maps raise memory by X%" | Shi 2023 numbers unobtainable; D'Antoni null; Farrand motivation caveat (s14; pass 1 s1) | strong (as a caution) |
| Node images must serve a function, no decorative filler | Carney & Levin typology (s2); seductive details (s6) | moderate (no per-category numbers) |
| Use mnemonic pictures for arbitrary or abstract items | Atkinson & Raugh 72 vs 46; Mastropieri & Scruggs about 1.6 (s3) | moderate (researcher-made tests; keyword limits) |
| Do not claim Picmonic/Sketchy-style products are proven | Yang 2014 industry-linked; no Sketchy trial (s3) | weak |
| Use cueing: colour or highlight tied to meaning | d=0.38, g+ 0.53/0.33, r=0.17 (s7) | strong |
| Colour must be consistent across study and recall; add a second cue | Skulmowski 2022 (s7) | weak |
| Colour-blind-safe palette | No study found; accessibility inference | weak (inference) |
| Keep labels touching the image; do not repeat the same text everywhere | Spatial contiguity 0.79, redundancy 0.87 medians (s4, s5) | moderate |
| Offer a lean (no-image) mode for experts | Expertise reversal (s5) | moderate |
| Expand progressively (segmenting, pre-training) | Medians 0.70, 0.46 (s4); Cowan about 4 chunks (pass 1 s9) | moderate |
| Spend aesthetic effort on core objects (friendly shapes, pleasant colours), not extra art | Brom 2018 d+ 0.32-0.39 vs seductive-details harm (s6) | moderate |
| Seductive extras hurt novices in short lessons | Sundararajan & Adesope 2020 (s6); Rey 2012 (pass 1 s4); Tislar & Steelman null | moderate (contested) |
| Make sibling images visually distinct | Picture superiority lost when pictures are similar (s1); isolation effect (pass 1 s6) | weak-moderate (inference) |
| Reserve exaggerated or bizarre treatment for a few key nodes | McDaniel & Einstein mixed lists (pass 1 s6); Kensinger arousal limits (s8) | moderate (bizarreness), weak (humour: no source) |
| Do not use hard-to-read fonts to aid memory | Xie 2018 d=0.01; failed replications (s9) | strong (against) |
| Beautiful design for adoption, not as a memory claim | Aesthetic-usability effect is perception (s9) | moderate (perception), weak (learning) |
| Curved organic branches | Bar & Neta preference only (pass 1 s11) | weak (preference), folklore for memory |
| Stable layout; never auto-re-layout seen maps | Data Mountain, Scarr et al. (s13); Dresler 2017 loci (pass 1 s7) | moderate (UI documents), weak (mind maps) |
| Animate expand/collapse and re-layout | Bederson & Boltman 1999; Heer & Robertson 2007 (s13) | moderate |
| Minimap and branch previews | SpaceTree controlled experiment (s13) | moderate |
| AI proposes, learner completes or checks | Bastani PNAS 2025 guardrails (s12); generation effects | moderate (indirect) |
| Allow sketching or doodling a node | Drawing effect (pass 1 s5); drawing median d=0.40 | moderate-strong |
| One word per branch | No support (pass 1 s10) | folklore |
| Pooled AI-image benefit | No controlled study of AI-generated node images found (s12) | weak |

### Gaps
- Items marked "weak (inference)" are design judgement calls and need user testing.

## Overall gaps to flag for the report writer
- Not obtained: Levin et al. 1987 effect sizes; Sundararajan pooled g; Shi 2023 pooled g; Chen et al. 2018 split-attention numbers; Schmidt 1994; Reber 2004; Mintzes comment; O'Day & Karpicke 2021; Card & Nation 2002; Pad++; Paivio concreteness numbers.
- Search snippets, not full texts, were the basis for nearly everything here. Check primary papers before any number is placed in a requirement.
