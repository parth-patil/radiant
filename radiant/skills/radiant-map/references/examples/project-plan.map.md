---
radiant: 1
title: Website relaunch
theme: clean
layout: right
tagColors: { risk: "#D55E00", done: "#009E73" }
---
<!-- A plan laid out to the right, with tasks, tags, owners in notes and a dependency link. -->

# Website relaunch {#launch}

## Discover {#discover}
- [x] Interview five customers {tags=done}
- [x] Audit analytics {tags=done}
- [ ] Summarise findings {#findings}
  Owner: research. Due end of week two.

## Design {#design}
- [ ] Sitemap {#sitemap}
- [ ] Wireframes
- [ ] Visual design {#visual tags=risk}
  Depends on brand refresh sign-off.

## Build {#build}
- [ ] Content migration {tags=risk}
- [ ] Templates
- [ ] Search

## Launch {#golive}
- [ ] Redirect plan
- [ ] Announcement
- [ ] Post-launch review

```links
findings -> sitemap : informs
visual -> golive : blocks {dash=dashed arrows=end}
```
