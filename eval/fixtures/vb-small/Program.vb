Public Module App
    Public Sub Main()
        Dim g As IGreeter = New Greeter()
        g.Greet("world")
    End Sub
End Module
