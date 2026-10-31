import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

async function texts(directory, declaredFile) {
  const candidates=(await readdir(directory)).filter(name=>/^(licen[sc]e|copying|notice)(\b|[._-])/i.test(name));
  if(declaredFile)candidates.push(path.resolve(directory,declaredFile));
  const result=[];
  for(const candidate of new Set(candidates)) {
    try { const content=await readFile(path.resolve(directory,candidate),"utf8");if(content.length<=512*1024)result.push({file:path.basename(candidate),content}); }
    catch(error){if(!["EISDIR","ENOENT","EPERM"].includes(error.code))throw error;}
  }
  return result;
}

export async function writeDependencyLicenses(repository,plugin,output) {
  const {stdout}=await promisify(execFile)("cargo",["metadata","--locked","--format-version","1","--filter-platform","x86_64-pc-windows-msvc","--manifest-path",path.join(plugin,"helper","Cargo.toml")],{cwd:repository,windowsHide:true,maxBuffer:64*1024*1024});
  const metadata=JSON.parse(stdout);
  const packages=new Map(metadata.packages.map(item=>[item.id,item]));
  const nodes=new Map(metadata.resolve.nodes.map(item=>[item.id,item]));
  const root=metadata.packages.find(item=>item.name==="mcdh-feedback-helper");
  const visited=new Set([root.id]);const pending=[root.id];const entries=[];
  while(pending.length){
    const id=pending.pop();
    for(const dependency of nodes.get(id).deps){if(dependency.dep_kinds.every(kind=>kind.kind==="dev"))continue;if(!visited.has(dependency.pkg)){visited.add(dependency.pkg);pending.push(dependency.pkg);}}
  }
  for(const id of visited){
    if(id===root.id)continue;
    const item=packages.get(id);
    entries.push({ecosystem:"cargo",name:item.name,version:item.version,license:item.license??"See license file",texts:await texts(path.dirname(item.manifest_path),item.license_file)});
  }
  const npmPending=["markdown-it","lucide"];const npmSeen=new Set();
  while(npmPending.length){
    const name=npmPending.pop();if(npmSeen.has(name))continue;npmSeen.add(name);
    const directory=path.join(plugin,"node_modules",name);
    const item=JSON.parse(await readFile(path.join(directory,"package.json"),"utf8"));
    entries.push({ecosystem:"npm",name:item.name,version:item.version,license:item.license,texts:await texts(directory)});
    npmPending.push(...Object.keys(item.dependencies??{}));
  }
  entries.sort((a,b)=>a.name.localeCompare(b.name)||a.version.localeCompare(b.version));
  const outputText=["Bundled dependency license notices", "Source repository licensing is separate. The following upstream declarations and license texts are retained without alteration.", ""];
  for(const entry of entries){outputText.push(`=== ${entry.ecosystem}: ${entry.name} ${entry.version} ===`,`Declared license: ${entry.license}`,"");for(const text of entry.texts)outputText.push(`--- ${text.file} ---`,text.content,"");}
  await writeFile(path.join(output,"DEPENDENCY_LICENSES.txt"),outputText.join("\n"),"utf8");
  await writeFile(path.join(output,"dependency-licenses.json"),JSON.stringify(entries.map(({texts,...entry})=>({...entry,license_files:texts.map(item=>item.file)})),null,2),"utf8");
  console.log(`Retained license declarations for ${entries.length} bundled dependencies`);
}
