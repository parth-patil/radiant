---
radiant: 1
title: Coffee
theme: hand-drawn
layout: mindmap
spacing: wide
seed: 7
themeSettings: { uppercaseMainBranches: true }
tagColors: { floral: "#795275", weekend: "#247371" }
assets:
  cup: art/cup.svg
---
<!-- Reference spec: every common attribute, a picture, tasks and cross-links. -->

# Coffee {#coffee shape=circle sticker=☕ image=cup alt="Line drawing of a cup"}

## Origins {#origins color=#A4402A side=left}
Where coffee is grown, and how altitude and processing shape flavour.

- Ethiopia {#ethiopia sticker=🌱 tags=floral,washed}
  - Yirgacheffe
  - Sidamo
- Colombia
  - Huila
  - Nariño
- Vietnam
  - Robusta {italic}

## Processing {#processing color=#637542 side=left layout=outline}
- Washed
- Natural
- Honey {href=https://example.org/honey-process}

## Brewing {#brewing color=#315A75 side=right branch=angular}
- Espresso {#espresso shape=box fill=#FFF3E0 bold emphasis=2}
  9 bar, 25 to 30 seconds, 1:2 ratio.
  - Ristretto
  - Lungo
- Pour-over {#pourover}
  - V60
  - Chemex
- Immersion
  - French press
  - AeroPress {#aeropress}

## To try {#todo color=#8B5709 side=right folded}
- [ ] Cold brew at home {tags=weekend}
- [x] Visit a roastery

```links
ethiopia -> pourover : bright, floral {dash=dashed arrows=end color=#795275}
aeropress -> espresso : similar strength
```
