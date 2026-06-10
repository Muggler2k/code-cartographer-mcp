public interface IGreeter
{
    string Greet();
}

public class Greeter : IGreeter
{
    public string Greet()
    {
        return Format();
    }

    private string Format()
    {
        return "hi";
    }
}
