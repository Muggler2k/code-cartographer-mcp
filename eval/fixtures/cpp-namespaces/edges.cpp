// Over-resolution regression constructs (ADR 0035 audit). Each pins that a call NEVER binds to a
// wrong target — the codebase-only honesty contract: a false edge is worse than `unresolved`.

struct Conn { void send(); };
void conn() {}                              // free fn whose name matches the pointer variable below
void useArrow(Conn* conn) { conn->send(); } // arrow member call -> unresolved#send, NOT the free conn()
void useDot(Conn& conn)   { conn.send(); }  // dot member call   -> unresolved#send

struct Box { };
Box makeBox() { return Box(); }             // constructor Box() -> NOT a call edge to the Box class node

void glob() {}                              // free fn colliding with Holder::glob
struct Holder {
  void glob();
  void callG() { ::glob(); }                // explicit-global ::glob -> the free glob(), NOT Holder::glob
};
