using System.Collections.Generic;
using System.Linq;

public static class Report
{
    public static int FirstScore(List<Item> items)
    {
        _ = nameof(Item); // operator, not a call — must emit NO edge
        return items.First().Score();
    }
}
