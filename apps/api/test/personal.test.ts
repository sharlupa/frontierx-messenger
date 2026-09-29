import { test } from "node:test"
import assert from "node:assert/strict"
import { api, befriend, registerUser, startTestServer } from "./helpers"

async function setup(base: string) {
  const owner=await registerUser(base,"organizer")
  const member=await registerUser(base,"participant")
  const outsider=await registerUser(base,"outsider")
  await befriend(base,owner,member)
  const created=await api(base,"/api/conversations",{token:owner.token,body:{kind:"group",title:"Plan",memberUsernames:["participant"]}})
  return {owner,member,outsider,id:created.json.conversation.id as string}
}
test("saved messages, folders, and mute preferences are durable and private",async(t)=>{
 const s=await startTestServer(); t.after(()=>s.close()); const c=await setup(s.base)
 const sent=await api(s.base,`/api/conversations/${c.id}/messages`,{token:c.member.token,body:{ciphertext:"cipher"}}); const mid=sent.json.message.id as string
 assert.equal((await api(s.base,`/api/conversations/${c.id}/messages/${mid}/save`,{token:c.owner.token,body:{active:true}})).status,200)
 assert.equal((await api(s.base,"/api/me/saved-messages",{token:c.owner.token})).json.saved.length,1)
 assert.equal((await api(s.base,"/api/me/saved-messages",{token:c.member.token})).json.saved.length,0)
 assert.equal((await api(s.base,`/api/conversations/${c.id}/messages/${mid}/save`,{token:c.outsider.token,body:{active:true}})).status,403)
 const folder=await api(s.base,"/api/me/folders",{token:c.owner.token,body:{name:"Important"}}); const fid=folder.json.folder.id as string
 assert.equal((await api(s.base,`/api/me/folders/${fid}/conversations`,{token:c.owner.token,body:{conversationId:c.id,active:true}})).status,200)
 assert.deepEqual((await api(s.base,"/api/me/folders",{token:c.owner.token})).json.folders[0].conversationIds,[c.id])
 assert.equal((await api(s.base,`/api/me/folders/${fid}/conversations`,{token:c.member.token,body:{conversationId:c.id,active:true}})).status,404)
 const until=new Date(Date.now()+3600000).toISOString()
 assert.equal((await api(s.base,`/api/conversations/${c.id}/mute`,{token:c.member.token,body:{mutedUntil:until}})).status,200)
 assert.ok((await api(s.base,"/api/conversations",{token:c.member.token})).json.conversations.find((x:any)=>x.id===c.id).mutedUntil)
 assert.equal((await api(s.base,"/api/conversations",{token:c.owner.token})).json.conversations.find((x:any)=>x.id===c.id).mutedUntil,null)
 assert.equal((await api(s.base,`/api/conversations/${c.id}/mute`,{token:c.member.token,body:{mutedUntil:"bad"}})).status,400)
 await api(s.base,`/api/conversations/${c.id}/messages/${mid}/delete`,{token:c.member.token,body:{}})
 assert.equal((await api(s.base,"/api/me/saved-messages",{token:c.owner.token})).json.saved.length,0)
})