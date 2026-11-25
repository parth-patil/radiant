import { removeLoneAliasGroups } from './aliases';
import { referencedAiJobs } from './ai-provenance';
import type { Doc, NodeId, Op, RootInfo, Vec2 } from '../types';
import { cloneNode, parseDocReport } from './doc';
import { effectiveRepresentation } from '../art/representation';
import { newId } from './ids';
import { rootOf, subtreeIds } from './commands';

export const BRANCH_MIME = 'application/x-radiant-branches+json';

/** The clipboard document includes only selected trees and their internal connections. */
export function copyBranches(doc:Doc, roots:NodeId[]):Doc {
  const nodes:Doc['nodes'] = {};
  const rootInfo:Doc['rootInfo'] = {};
  for (const root of roots) {
    for (const id of subtreeIds(doc,root)) nodes[id]=cloneNode(doc.nodes[id]);
    nodes[root].parent=null;
    const mode=effectiveRepresentation(doc,root);
    if(mode!=='vector') nodes[root].representation=mode;
    rootInfo[root]=doc.rootInfo[rootOf(doc,root)];
  }
  removeLoneAliasGroups(nodes);
  const tags=new Set(Object.values(nodes).flatMap(node=>(node.tags ?? []).map(tag=>tag.toLowerCase())));
  const colors=Object.entries(doc.tagColors ?? {}).filter(([tag])=>tags.has(tag));
  return {version:1,id:newId(),title:'Copied branches',themeId:doc.themeId,seed:doc.seed,created:doc.created,modified:doc.modified,
    roots:[...roots],nodes,rootInfo,aiJobs:referencedAiJobs(nodes,doc.aiJobs),tagColors:colors.length ? Object.fromEntries(colors) : undefined,links:doc.links.filter(link=>nodes[link.from] && nodes[link.to])};
}

export function parseBranches(json: string): Doc | null {
  if (!json) return null;
  const result=parseDocReport(json);
  if (result.repairs.length) throw new Error('The copied branches contain invalid map data.');
  return result.doc;
}

interface Destination { parent:NodeId|null; index:number; rootInfo?:RootInfo }

/** Allocate every new id first so connection endpoints and artwork child anchors can be remapped. */
export function insertBranches(source:Doc, destination:(root:NodeId,index:number)=>Destination) {
  const remap=new Map(Object.keys(source.nodes).map(id=>[id,newId()]));
  const ops:Op[]=[];
  const aliasGroups = new Map<string, string>();
  const jobs = new Map<string, string>();
  for (const [old, value] of Object.entries(referencedAiJobs(source.nodes, source.aiJobs) ?? {})) {
    const id = newId();
    jobs.set(old, id);
    // A saved scoped prompt contains the old permanent node IDs.
    ops.push({ t: 'aiJob', id, value: { ...value, scopeId: undefined } });
  }
  function insert(old:NodeId, dest:Destination) {
    const node=cloneNode(source.nodes[old]);
    node.id=remap.get(old)!;
    node.parent=dest.parent;
    node.children=[];
    if (node.aliasGroup) {
      const previous = node.aliasGroup;
      const group = aliasGroups.get(previous) ?? newId();
      aliasGroups.set(previous, group);
      node.aliasGroup = group;
    }
    if (node.origin?.by === 'ai') node.origin.job = jobs.get(node.origin.job) ?? node.origin.job;
    if (node.lastAiJob) node.lastAiJob = jobs.get(node.lastAiJob) ?? node.lastAiJob;
    for (const art of [node.pictureArt,node.svgArt,node.artReference]) {
      const anchors=art?.anchors;
      if (!anchors?.outByChild) continue;
      const byChild:Record<NodeId,Vec2>={};
      for (const [child,point] of Object.entries(anchors.outByChild)) {
        const copied=remap.get(child);
        if(copied) byChild[copied]=point;
      }
      anchors.outByChild=byChild;
    }
    ops.push({t:'insert',node,...dest});
  }
  for (const [index,root] of source.roots.entries()) {
    insert(root,destination(root,index));
    for (const parent of subtreeIds(source,root)) {
      source.nodes[parent].children.forEach((child,index)=>insert(child,{parent:remap.get(parent)!,index}));
    }
  }
  for (const link of source.links) ops.push({t:'link',link:{...link,id:newId(),from:remap.get(link.from)!,to:remap.get(link.to)!}});
  return {ops,created:source.roots.map(id=>remap.get(id)!)};
}
