Public Interface IGreeter
    Function Greet(name As String) As String
End Interface

Public Class Greeter
    Implements IGreeter

    Public Function Greet(name As String) As String Implements IGreeter.Greet
        Return Format(name)
    End Function

    Private Function Format(name As String) As String
        Return "Hello " & name
    End Function
End Class
