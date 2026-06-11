using System.Collections.Generic;
using System.Linq;

public static class Report
{
    public static int FirstScore(List<Item> items)
    {
        return items.First().Score();
    }
}
