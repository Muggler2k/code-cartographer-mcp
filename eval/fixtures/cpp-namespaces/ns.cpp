namespace geometry {
  int side() { return 4; }
  int area() { return side() * side(); }   // bare side() inside geometry -> geometry::side (enclosing-first, N-S3)
}

namespace text {
  int helper() { return 1; }               // namespace disambiguation: text::helper, distinct from any global helper
}

namespace outer {
  namespace inner {
    int deep() { return 9; }                // nested: outer::inner::deep
  }
}

struct inner {                             // collision bait: a TYPE `inner` with member inner::deep
  int deep() { return 0; }                 // a truncated `inner::deep` lookup must NOT capture outer::inner::deep
};

namespace one { int dup() { return 11; } } // one::dup and two::dup collide on the bare name `dup`
namespace two { int dup() { return 22; } }

using geometry::side;                      // using-declaration: bare side() -> geometry::side
using namespace text;                      // using-directive: bare helper() -> text::helper
using one::dup;                            // conflicting using-declarations for bare `dup`:
using two::dup;                            // -> AMBIGUOUS, so a bare dup() must stay unresolved (never a guess)

int compute() {
  return geometry::area();                  // qualified call -> geometry::area (N-S3)
}

int viaUsing() {
  return side() + helper();                 // side -> geometry::side (using-decl); helper -> text::helper (using-dir)
}

int useDup() {
  return dup();                             // ambiguous (one::dup vs two::dup) -> unresolved, NOT a guess
}

int useRemote() {
  return remote::fetch();                   // cross-FILE namespace call -> lib.cpp#remote::fetch (N-S3 cross-file)
}

int useGadget() {
  return Gadget::spin();                     // out-of-line member def (lib.cpp) is NOT indexed -> unresolved
}

int useDeep() {
  return outer::inner::deep();              // fully-qualified -> outer::inner::deep, NEVER inner::deep (no false edge)
}

int main() {                               // entry point
  return compute() + geometry::side();      // bare compute(); qualified geometry::side -> geometry::side (N-S3)
}
