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

int compute() {
  return geometry::area();                  // qualified call -> geometry::area (N-S3)
}

int useDeep() {
  return outer::inner::deep();              // fully-qualified -> outer::inner::deep, NEVER inner::deep (no false edge)
}

int main() {                               // entry point
  return compute() + geometry::side();      // bare compute(); qualified geometry::side -> geometry::side (N-S3)
}
