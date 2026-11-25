"""Drive the five offline generation fault cases with the Browser Use CLI."""

import os
import time

url = os.environ.get('RADIANT_BROWSER_URL', 'http://127.0.0.1:1420/').rstrip('/') + '/?inspector=1'
new_tab(url)
wait_for_load()

def until(expression, seconds=20):
    for _ in range(seconds*10):
        result=js(expression)
        if result:
            return result
        time.sleep(.1)
    raise RuntimeError(expression)
def button(name):
    pos=js('''(() => {
      const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===%r&&b.getBoundingClientRect().width&&!b.disabled);
      if(!b)return null;
      b.scrollIntoView({block:'center'});
      const r=b.getBoundingClientRect();
      return [r.x+r.width/2,r.y+r.height/2];
    })()''' % name)
    if not pos: raise RuntimeError(name)
    click_at_xy(*pos)
until("Boolean(window.__radiant?.c.ready && window.__radiant.c.aiStatus?.available)")
js(r'''(async () => {
const {c}=window.__radiant;
const {docFromOutline}=await import('/src/lib/core/model/outline.ts');
const {validateDoc}=await import('/src/lib/core/model/index.ts');
const preview=c.host.preview.bind(c.host);
const setup=(name,children=[])=>{
  const doc=docFromOutline(name,{text:name,children:children.map(text=>({text,children:[]}))});
  c.loadDoc(doc,null,false);c.flush();c.select([doc.roots[0]]);
};
const wait=async fn=>{
  for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,25));}
  throw Error('Editor did not finish');
};
const save=async (name, checker) => {
  if(validateDoc(c.doc).length) throw Error(JSON.stringify(validateDoc(c.doc)));
  const docId=c.doc.id;
  const path='Offline generation fault '+crypto.randomUUID()+' '+name+'.radiant';
  c.host.pickSavePath=async()=>path;
  if(!await c.save())throw Error('save failed');
  await c.openDoc(c.filePath,true);
  await wait(()=>c.doc.id===docId&&c.filePath===path);
  if(validateDoc(c.doc).length)throw Error('invalid after reopen');
  checker?.();
  const id=c.doc.roots[0];
  c.editor.apply({source:'user',label:'Edit reopened fault fixture',ops:[{t:'set',id,patch:{text:c.doc.nodes[id].text+' edited'}}]});
  if(!c.doc.nodes[id].text.endsWith(' edited')||!await c.save())throw Error('reopened map was not editable');
  return Object.keys(c.doc.nodes).length;
};
const frame=(delay,event)=>({delay,event});
const row=(id,parent,title)=>JSON.stringify({id,parent,title})+'\n';
const landed=()=>Object.values(c.doc.nodes).filter(n=>n.text.startsWith('Kept'));
window.rel03={c,setup,save,preview,results:{},validateDoc};
for (const [name,code] of [['Malformed line',null],['Dropped connection','stream_interrupted'],['Killed CLI','process_exited']]){
  setup(name);
  c.host.preview=async()=>[
    frame(20,{kind:'started',route:'replay'}),
    frame(20,{kind:'delta',text:row('root',null,'Kept root')+
      (code? '': '{ bad fixture line }\n')+row('child','root','Kept child')+(code?'{"id":"partial"':'')}),
    frame(30,code?{kind:'error',code,message:'Offline fixture failure'}:{kind:'done'})
  ];
  c.topic='Generate '+name;
  await c.generate();
  await wait(()=>!c.gen&&landed().length===2);
  if(c.editor.hasOpenGroup||landed().length!==2)throw Error(name+' invalid group');
  c.editor.undo();
  if(landed().length)throw Error(name+' was not one edit group');
  c.editor.redo();
  if(landed().length!==2)throw Error(name+' redo lost surviving nodes');
  rel03.results[name]=await save(name,()=>{if(landed().length!==2)throw Error(name+' lost nodes');});
}
setup('Invalid SVG',['Unaffected SVG leaf']);
c.host.preview=async req=>{
 const frames=await preview(req);
 for(const f of frames){
   if(f.event.kind==='delta'&&f.event.text.includes('data-anchor-out=')){
     f.event.text=f.event.text.replace(/ data-anchor-out="[^"]+"/,'');
   }
 }
 return frames;
};
return rel03.results;
})()''')
print(js('rel03?.results'))
# Reject malformed root artwork, preserving conforming artwork on its sibling.
js('''(() => {const s=document.querySelector('#svg-repairs');s.value='0';s.dispatchEvent(new Event('change',{bubbles:true}));})()''')
button('Generate SVG subtree')
until("!!document.querySelector('.art-confirmation button.primary:not(:disabled)')")
button('Confirm generation')
until("rel03.c.doc.nodes[rel03.c.doc.roots[0]]?.svgArtError")
print(js(r'''(async()=>{
const {c,save,setup,preview}=rel03;
const checkSvg=()=>{
 const root=c.doc.nodes[c.doc.roots[0]], child=c.doc.nodes[root.children[0]];
 if(!root.svgArtError?.includes('data-anchor-out')||root.svgArt||!child.svgArt||child.svgArtError)throw Error('SVG fault did not remain node-local');
};
checkSvg();
rel03.results['Invalid SVG']=await save('Invalid SVG',checkSvg);
setup('Picture batch',Array.from({length:9},(_,i)=>i===4?'Only failed image':'Picture child '+(i+1)));
rel03.imageTurns=0;
c.host.preview=async req=>{
 if(req.kind==='image'){
   rel03.imageTurns++;
   if(req.prompt.startsWith('Create one picture for the mind-map node "Only failed image".')){
      return [{delay:20,event:{kind:'started',route:'replay'}},{delay:40,event:{kind:'error',code:'other',message:'Offline single-image failure'}}];
   }

 }
 return preview(req);
};
return rel03.results;
})()'''))
button('Generate picture subtree')
until("!!document.querySelector('.art-confirmation button.primary:not(:disabled)')")
button('Confirm generation')
# Chrome defers Canvas encodes for the raster fixture in a hidden headless tab.
if js("document.visibilityState") == 'hidden':
    activate_tab(current_tab())
until("!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Use style reference')")
button('Use style reference')
until("!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Use sample')")
button('Use sample')
until("rel03.imageTurns===11 && !rel03.c.editor.hasOpenGroup",30)
print(js(r'''(async()=>{
const {c,save}=rel03;
const checkPictures=()=>{
 const nodes=Object.values(c.doc.nodes), failures=nodes.filter(n=>n.pictureArtError);
 if(nodes.length!==10||failures.length!==1||failures[0].text!=='Only failed image'||failures[0].pictureArt||
    nodes.filter(n=>n.pictureArt).length!==9)throw Error(JSON.stringify({nodes:nodes.map(n=>[n.text,!!n.pictureArt,n.pictureArtError])}));
};
checkPictures();
const group={undo:c.editor.undoLabel};
c.editor.undo();
if(Object.values(c.doc.nodes).some(n=>n.pictureArt||n.pictureArtError))throw Error('Artwork batch did not undo as one group');
c.editor.redo();checkPictures();
rel03.results['Picture batch']=await save('Picture batch',checkPictures);
const failed=Object.values(c.doc.nodes).find(n=>n.pictureArtError);
c.select([failed.id]);
c.flush();
return {results:rel03.results,imageTurns:rel03.imageTurns,marked:failed.text,group};
})()'''))

note = until("""[...document.querySelectorAll('[role="status"]')].map(n=>n.textContent)
    .find(text=>text.includes('Picture generation failed for this node.'))""")
assert 'Offline single-image failure' in note, note
