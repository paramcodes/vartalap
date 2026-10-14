import * as p from '../packages/protocol/src/index.ts';
// seq is a STRING, never a number — JSON numbers lose precision above 2^53
const big = p.seq.parse('9007199254740993');           // 2^53 + 1
console.log('seq parses:', big, '| type:', typeof big);
console.log('seq rejects a bare number:', p.seq.safeParse(9007199254740993).success === false);
console.log('round-trip bigint:', p.seqFromBigInt(p.seqToBigInt(big)) === big);
console.log('handle rejects dots:', p.parseHandle('alice.smith') === null);
console.log('handle normalizes:', p.parseHandle('  Alice_01 ') );
// permission carries a REASON, because blocked_by_me and blocked_by_them differ
console.log('permission:', JSON.stringify(p.sendPermission.parse({allowed:false, reason:'blocked_by_them'})));
// a frame must carry its conversation even though the channel already implies it
const f = p.serverFrame.parse({type:'presence.changed', userId:'11111111-1111-4111-8111-111111111111', online:true});
console.log('presence frame:', JSON.stringify(f));
// pending messages have a null seq and must NOT be given one client-side
const m = p.message.parse({id:'0198c0de-0000-7000-8000-000000000001',conversationId:'0198c0de-0000-7000-8000-000000000002',authorId:'0198c0de-0000-7000-8000-000000000003',body:'hi',attachments:[],seq:null,createdAt:new Date().toISOString()});
console.log('pending message seq:', m.seq);
