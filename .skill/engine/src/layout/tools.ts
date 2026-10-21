import type { Rect, Matrix } from './plan.ts';
import { SAFE_AREA } from '../themes/shared.ts';
export type { Rect, Matrix } from './plan.ts';
export function frame(width:number,height:number) {
  if(!(width>0&&height>0))throw Error('LAYOUT_FRAME_SIZE');
  const vertical=height>width,s=SAFE_AREA[vertical?'vertical':'horizontal'],sx=width/(vertical?1080:1920),sy=height/(vertical?1920:1080);
  const safe={x:s.left*sx,y:s.top*sy,width:width-(s.left+s.right)*sx,height:height-(s.top+s.bottom)*sy};
  return {canvas:{x:0,y:0,width,height},safe,contentBox:{...safe},center:{x:width/2,y:height/2}};
}
export function stack(box:Rect,heights:readonly number[],gap=8):Rect[] {
  let y=box.y;return heights.map(height=>{const r={x:box.x,y,width:box.width,height};y+=height+gap;return r;});
}
export function row(box:Rect,widths:readonly number[],gap=8):Rect[] {
  let x=box.x;return widths.map(width=>{const r={x,y:box.y,width,height:box.height};x+=width+gap;return r;});
}
export function grid(box:Rect,columns=6,rows=1,gap=8):Rect[] {
  if(!Number.isInteger(columns)||!Number.isInteger(rows)||columns<1||rows<1||gap<0)throw Error('LAYOUT_GRID');
  const w=(box.width-gap*(columns-1))/columns,h=(box.height-gap*(rows-1))/rows;
  if(w<=0||h<=0)throw Error('LAYOUT_GRID_FIT');
  return Array.from({length:columns*rows},(_,i)=>({x:box.x+(i%columns)*(w+gap),y:box.y+Math.floor(i/columns)*(h+gap),width:w,height:h}));
}
export function anchor(to:Rect,edge:'top'|'bottom'|'left'|'right'|'center',gap=8):{x:number;y:number} {
  const x=to.x+to.width/2,y=to.y+to.height/2;
  return edge==='top'?{x,y:to.y-gap}:edge==='bottom'?{x,y:to.y+to.height+gap}:edge==='left'?{x:to.x-gap,y}:edge==='right'?{x:to.x+to.width+gap,y}:{x,y};
}
/** Optional fractions within a caller-selected contentBox. Typography remains theme-owned. */
export function slot(name:'title'|'visual'|'body'|'source'|'footer',box:Rect):Rect {
  const [start,end]={title:[0,.16],visual:[.2,.61],body:[.65,.8],source:[.84,.9],footer:[.94,1]}[name]!;
  return {x:box.x,y:box.y+box.height*start!,width:box.width,height:box.height*(end!-start!)};
}
/** Capture getTransform() on the world layer, restore, then place a screen label at this point. */
export function follow(point:{x:number;y:number},matrix:Matrix):{x:number;y:number} {
  return {x:matrix[0]*point.x+matrix[2]*point.y+matrix[4],y:matrix[1]*point.x+matrix[3]*point.y+matrix[5]};
}
export function sourceMapping(source:Rect,destination:Rect):Matrix {
  if(source.width<=0||source.height<=0)throw Error('LAYOUT_SOURCE_SIZE');
  const sx=destination.width/source.width,sy=destination.height/source.height;
  return [sx,0,0,sy,destination.x-source.x*sx,destination.y-source.y*sy];
}
