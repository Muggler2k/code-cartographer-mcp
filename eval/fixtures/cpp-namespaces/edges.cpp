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

struct Svc2 { void step(); void run2(); };
void Svc2::step() { }
void Svc2::run2() { step(); }               // out-of-line member body: step() -> Svc2::step (member-first), NOT free step()
void step() {}                              // free fn colliding with the member Svc2::step

int useAnon() { return anonFn(); }          // anonFn (lib.cpp anon namespace) has internal linkage -> unresolved

struct Svc3 { void run3(); void poke(); };
void Svc3::run3() { poke(); }               // poke() is a DECLARED-only member of Svc3 -> unresolved, NOT free poke()
void poke() {}                              // free fn colliding with the declared-only member Svc3::poke

struct RefHolder { int& acquire(); void run4(); };
void RefHolder::run4() { acquire(); }       // acquire() is a reference-return DECLARED-only member -> unresolved, NOT free acquire()
int acquire() { return 0; }                 // value-return free fn, same name (the &-declarator quirk would over-resolve without the fix)

struct Tmpl { template<class T> void emit(); void run5(); };
void Tmpl::run5() { emit(); }               // emit() is a TEMPLATED declared-only member (template_declaration) -> unresolved, NOT free emit()
void emit() {}                              // free fn colliding with the templated member Tmpl::emit

struct Frd { friend void buddy(); void run6(); };
void Frd::run6() { buddy(); }               // buddy() is a FRIEND (not a member) -> resolves to the free buddy(), NOT unresolved
void buddy() {}

void handle() {}
void invoke(void(*handle)()) { handle(); }  // handle is a fn-pointer PARAM shadowing the free handle() -> dynamic, unresolved
void tickCb() {}
void runCb() { std::function<void()> tickCb; tickCb(); }  // tickCb is a std::function LOCAL shadowing free tickCb() -> dynamic, unresolved
struct Functor { void operator()(); };
void doit() {}
void useFunctor() { Functor doit; doit(); }  // doit is a functor LOCAL shadowing free doit() -> dynamic, unresolved
void cb1() {}
void cb2() {}
void runMulti() { std::function<void()> cb1, cb2; cb1(); cb2(); }  // BOTH multi-declarator locals shadow -> dynamic, unresolved
void proto() {}
void usesProto() { void proto(); proto(); }  // local PROTOTYPE is an extern ref, NOT a callable local -> resolves to free proto()


