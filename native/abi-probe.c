/* Print the target archive's public ABI manifest during a native build. */
#include <stdio.h>
#include <ghostty/vt/types.h>
int main(void) { return puts(ghostty_type_json()) < 0; }
