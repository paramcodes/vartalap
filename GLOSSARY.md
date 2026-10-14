# vartalap

The language of a Messenger-style chat app: who people are, where they talk, what they send, and what the system owes them. Anything not listed here is either a general software concept or a feature outside v1.

## Identity

**User**:
The identity that signs in to vartalap and can be a member of conversations. One person is one user; a user can belong to many conversations.
_Avoid_: Account, person (when you mean the identity rather than the human)

**Credential**:
A record proving that a user may sign in — a password, or a link to an external identity provider. A user may hold several. It belongs to the auth layer and is never rendered.
_Avoid_: Account, login

**Handle**:
A user's unique, case-normalized identifier — the form by which others address them. Unique across every user, and meaningful beyond its display casing.
_Avoid_: Username, name

**Display name**:
The free-form name a user chooses to be shown by. Not unique, may be anything, may change freely.
_Avoid_: Handle, username

**Avatar**:
The media a user or conversation displays as its picture. A reference to media, not a distinct concept.
_Avoid_: Image, photo

## Conversations

**Conversation**:
A place where a set of members exchange messages. It has a lifecycle — created, has members, has a transcript — whether or not anyone is currently looking at it.
_Avoid_: Chat, thread, DM, room

**Direct conversation**:
A conversation with exactly two members. Defined by its membership, not by a stored type.
_Avoid_: DM, private chat, one-on-one

**Group conversation**:
A conversation with three or more members.
_Avoid_: Group chat, supergroup

**Member**:
A user who belongs to a conversation. Everyone a conversation holds is a member, whatever role they may later hold — a role is an attribute of a membership, not a kind of membership. The only way membership ends in v1 is a member leaving.
_Avoid_: Participant, attendee, owner, admin

**Former member**:
A user who has left a conversation, and remains one. Their messages and their receipt survive; nothing they sent is deleted and no membership is erased. Leaving a direct conversation ends the conversation too, since a conversation with one member is nothing.
_Avoid_: Removed member, ex-member, kicked, deleted user

**Transcript**:
The ordered messages of a conversation, oldest first. The history as a member sees it.
_Avoid_: Chat history, message log, timeline

## Messages

**Message**:
Content a member composed and sent into a conversation: text, or one or more attachments. The only thing in a conversation that a member authors, and therefore the only thing in a transcript.
_Avoid_: Post, event, item

**Attachment**:
One message's reference to one piece of media. A property of a message rather than a thing in its own right; the same media may be attached to several messages.
_Avoid_: File, media (when you mean the reference)

**Media**:
A stored file vartalap holds — its bytes, its owner, its lifetime. May be attached to messages, may serve as an avatar, or stand alone unreferenced.
_Avoid_: Attachment, file, blob

## Reading

**Receipt**:
A member's record of how far they have read a conversation. It is a statement about the member and never about the message — a message is not "read" or "unread" on its own — and it advances to the end of the transcript the moment the conversation is shown to them. A member always has one; whether the other members can observe it is the member's to decide.
_Avoid_: Read marker, seen-by, message status, last-read

**Read**:
A message is read by a member once the conversation holding it has been shown to them. Showing a conversation reads all of it, including what was never scrolled to: reading is not tracked per message, and nothing is read that has not been shown.
_Avoid_: Seen, delivered, viewed

**Seen**:
Not a domain word. The interface prints "Seen" because Messenger's does; the domain says Read and Receipt, and the two never meet. Copy may borrow a stranger's word, but nothing in the model, the schema, or the protocol may.

**Unread count**:
The number of messages in a transcript that come after a member's receipt. Always derived from the receipt, never stored — a stored count is a second source of truth that disagrees with the receipt the moment either is wrong.
_Avoid_: Unread messages (when you mean the number), unread total, badge

## Delivery

**Queued send**:
A message a member composed that the server has not yet acknowledged. It survives a page reload, flushes when the connection returns, and is visible to the member as a pending item.
_Avoid_: Pending message, unsent message

**Idempotency key**:
A value generated once for a queued send and unchanged across every retry of it, so the server recognises a repeat as the same message rather than a second one.
_Avoid_: Client ID, request ID, dedupe key

**Send queue**:
The client's durable store of queued sends, which outlives a page reload and empties when the connection returns. It belongs to one browser profile and is never shared or synchronised.
_Avoid_: Outbox (when you mean the client's side), pending list

**Outbox**:
The server's durable record of sends it has accepted but not yet delivered to subscribers. It is what makes delivery survive a crash between accepting a message and handing it on.
_Avoid_: Send queue, event log

## Live signals

**Presence**:
The fact that a user has a live connection to vartalap: true or false, with no history behind it. It is read at the resolution of a 45-second window, so it means connected within the last 45 seconds rather than connected at this instant.
_Avoid_: Online status, active now, last seen

**Typing**:
The ephemeral signal that a member is composing in a conversation. Lossy by design and never stored — nothing in a transcript may depend on it, and a member who never saw it missed nothing.
_Avoid_: Composing status, is-typing flag, keystroke