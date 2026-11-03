@extends('layouts.app')
@section('title', 'Masuk | LactOS Digital Twin')
@section('content')
<div class="card" style="max-width: 400px; margin: 48px auto;">
    <h2>LactOS Digital Twin</h2>
    <form method="POST" action="/login">
        @csrf
        <label>Email<input type="email" name="email" value="{{ old('email') }}" required autofocus></label>
        <label>Kata sandi<input type="password" name="password" required></label>
        @error('email')<p class="err">{{ $message }}</p>@enderror
        <button type="submit">Masuk</button>
    </form>
</div>
@endsection
