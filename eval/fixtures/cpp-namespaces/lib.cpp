namespace remote {
  int fetch() { return 42; }                // namespace member, called cross-file from ns.cpp (same dir)
}

struct Gadget { int spin(); };              // out-of-line member def below must NOT be a cross-file
int Gadget::spin() { return 7; }            // index target (declarator-qualified, not scope-qualified)

namespace { int anonFn() { return 9; } }    // anonymous namespace = INTERNAL linkage (TU-local) -> never indexed cross-file
