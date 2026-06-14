#include "calc.h"

class Calculator {
public:
  int run() { return step() + step(); }   // intra-file method calls -> direct/likely
  int step() { return value(); }
private:
  int value() { return 7; }
};

static int helper() { return 1; }          // static -> internal (exported false)

int total() {
  return helper() + shared_util();         // helper: intra-file; shared_util: cross-file (unresolved)
}

int main() {                               // entry point
  return total();
}
