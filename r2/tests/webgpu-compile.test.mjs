import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import converter from "../webgl2gpu/convert.cjs";

// Check the code sent to the browser. A second reachable traversal call can
// duplicate thousands of instructions when the graphics driver inlines it.
test("各 WebGPU 射线路径共用一个格子遍历调用点", (t) => {
  const dir=mkdtempSync(join(tmpdir(),"r2-compile-test-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  for(const name of ["shading","accumulation","photo","basic-pick","voxel-pick"]){
    converter.convert(name,dir);
    const wgsl=readFileSync(join(dir,name+".wgsl"),"utf8");
    // Naga mangles argument types into function names. Count definition + calls.
    assert.equal(wgsl.match(/\bmarch\w*\(/g)?.length,2,name);
    assert.equal(wgsl.match(/\bsunVisibility\w*\(/g)?.length??0,name.endsWith("-pick")?0:2,name);
    const slots=wgsl.match(/^\/\/ Uniform slots: (.*)$/m)[1].split(",");
    if(name==="photo"||name==="accumulation")assert.equal(slots.includes("uBounces"),name==="photo");
  }
});
